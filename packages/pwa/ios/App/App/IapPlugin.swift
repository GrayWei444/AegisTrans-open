//
//  IapPlugin.swift
//  AegisTrans iOS — StoreKit 2 內購原生 plugin（自寫，不依賴 RevenueCat 等第三方）。
//
//  職責：
//   - getProducts(productIds)  → 回各商品的在地化價格字串（app 內顯示用 StoreKit 真實價，不寫死）
//   - purchase(productId)      → StoreKit 2 購買 → 回「簽名交易 jwsRepresentation」給 JS
//                                送後端 /subscription/verify 驗章設 tier（自家後端驗收據）
//   - restorePurchases()       → 列 currentEntitlements 的 jws（恢復購買 / 驗證失敗的補救路徑）
//   - finishTransaction(id)    → 後端驗證成功後呼叫，結束交易
//   - Transaction.updates 監聽 → 續訂 / 退款 / 跨裝置購買事件 → notifyListeners("transactionUpdate")
//
//  驗收據在【後端】做（用 jwsRepresentation + Apple App Store Server API 驗章），這裡只負責
//  跟 StoreKit 互動 + 把簽名交易交出去。對應 docs/IAP_ASC_SETUP.md 的「自家後端驗收據」方案。
//
//  Product IDs（ASC 定案，見 memory project_iap_asc）：
//   com.aegisrd.aegistrans.pro.monthly / .pro.yearly（訂閱）/ .pro.lifetime（非消耗）
//

import Foundation
import Capacitor
import StoreKit

@objc(IapPlugin)
public class IapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IapPlugin"
    public let jsName = "Iap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise),
    ]

    /// 監聽 Transaction.updates（背景續訂 / 退款 / 其他裝置購買）。plugin load 時啟動。
    private var updatesTask: Task<Void, Never>?

    override public func load() {
        updatesTask = Task.detached { [weak self] in
            for await update in Transaction.updates {
                guard let self = self else { continue }
                guard case .verified(let transaction) = update else { continue }
                // 把簽名交易丟給 JS → JS 送後端 verify（續訂 / 退款都會重設 tier）
                // jwsRepresentation 在 VerificationResult 包裝層（update），不是解包後的 transaction。
                self.notifyListeners("transactionUpdate", data: [
                    "jws": update.jwsRepresentation,
                    "productId": transaction.productID,
                    "transactionId": String(transaction.id),
                    "revoked": transaction.revocationDate != nil,
                ])
                // CR-05：不在此 finish。後端是 tier 的 source of truth — 等 JS(startIapUpdateListener)
                // 把 jws 送後端 verify 成功後再 finishTransaction。未 finish 的交易 StoreKit 會在下次
                // 啟動重送（idempotent re-verify），避免「離線/未驗證就 finish」造成後端永遠收不到。
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    // MARK: - isAvailable

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 15.0, *) {
            call.resolve(["available": AppStore.canMakePayments])
        } else {
            call.resolve(["available": false, "reason": "StoreKit 2 requires iOS 15+"])
        }
    }

    // MARK: - getProducts

    @objc func getProducts(_ call: CAPPluginCall) {
        guard let ids = call.getArray("productIds", String.self), !ids.isEmpty else {
            call.reject("productIds (string[]) required")
            return
        }
        Task {
            do {
                let products = try await Product.products(for: Set(ids))
                let out: [[String: Any]] = products.map { p in
                    var item: [String: Any] = [
                        "id": p.id,
                        "displayName": p.displayName,
                        "description": p.description,
                        "displayPrice": p.displayPrice,            // 已在地化的價格字串（app 直接顯示）
                        "price": (p.price as NSDecimalNumber).doubleValue,
                        "currencyCode": p.priceFormatStyle.currencyCode,
                        "type": Self.typeString(p.type),
                    ]
                    if let sub = p.subscription {
                        item["subscriptionPeriod"] = Self.periodString(sub.subscriptionPeriod)
                    }
                    return item
                }
                call.resolve(["products": out])
            } catch {
                call.reject("getProducts failed: \(error.localizedDescription)", nil, error)
            }
        }
    }

    // MARK: - purchase

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId") else {
            call.reject("productId required")
            return
        }
        // CR-05：把帳號綁進交易（client 用 user_id 算出的 UUID）。Apple 原樣回填，後端比對。
        let accountToken = call.getString("appAccountToken").flatMap { UUID(uuidString: $0) }
        Task {
            do {
                let products = try await Product.products(for: [productId])
                guard let product = products.first else {
                    call.reject("Product not found: \(productId)")
                    return
                }
                var options: Set<Product.PurchaseOption> = []
                if let token = accountToken {
                    options.insert(.appAccountToken(token))
                }
                let result = try await product.purchase(options: options)
                switch result {
                case .success(let verification):
                    // 不在這裡 finish — 等後端 verify 成功後 JS 再呼叫 finishTransaction。
                    switch verification {
                    case .verified(let transaction):
                        // jwsRepresentation 在 VerificationResult 包裝層（verification），不是 transaction。
                        call.resolve([
                            "status": "purchased",
                            "jws": verification.jwsRepresentation,   // ← 交給後端 /subscription/verify 驗章
                            "productId": transaction.productID,
                            "transactionId": String(transaction.id),
                        ])
                    case .unverified(_, let error):
                        call.reject("Transaction failed StoreKit verification: \(error.localizedDescription)")
                    }
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                case .pending:
                    // 例如「家長同意」待批 — 之後會走 Transaction.updates
                    call.resolve(["status": "pending"])
                @unknown default:
                    call.resolve(["status": "unknown"])
                }
            } catch {
                call.reject("purchase failed: \(error.localizedDescription)", nil, error)
            }
        }
    }

    // MARK: - restorePurchases（列目前有效權利的簽名交易，給後端逐一 verify）

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task {
            var items: [[String: Any]] = []
            for await result in Transaction.currentEntitlements {
                guard case .verified(let transaction) = result else { continue }
                if transaction.revocationDate != nil { continue }  // 已退款的略過
                // jwsRepresentation 在 VerificationResult 包裝層（result），不是 transaction。
                items.append([
                    "jws": result.jwsRepresentation,
                    "productId": transaction.productID,
                    "transactionId": String(transaction.id),
                ])
            }
            call.resolve(["transactions": items])
        }
    }

    // MARK: - finishTransaction（後端 verify 成功後呼叫，結束該筆交易）

    @objc func finishTransaction(_ call: CAPPluginCall) {
        guard let txIdStr = call.getString("transactionId"), let txId = UInt64(txIdStr) else {
            call.reject("transactionId required")
            return
        }
        Task {
            for await result in Transaction.all {
                guard case .verified(let transaction) = result else { continue }
                if transaction.id == txId {
                    await transaction.finish()
                    break
                }
            }
            call.resolve()
        }
    }

    // MARK: - helpers

    private static func typeString(_ t: Product.ProductType) -> String {
        switch t {
        case .autoRenewable: return "auto_renewable"
        case .nonConsumable: return "non_consumable"
        case .consumable: return "consumable"
        case .nonRenewable: return "non_renewable"
        default: return "unknown"
        }
    }

    private static func periodString(_ p: Product.SubscriptionPeriod) -> String {
        let unit: String
        switch p.unit {
        case .day: unit = "day"
        case .week: unit = "week"
        case .month: unit = "month"
        case .year: unit = "year"
        @unknown default: unit = "unknown"
        }
        return "\(p.value)_\(unit)"
    }
}
