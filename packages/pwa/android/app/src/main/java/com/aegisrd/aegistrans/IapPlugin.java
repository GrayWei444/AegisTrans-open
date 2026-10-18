package com.aegisrd.aegistrans;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Google Play Billing bridge. Verification and entitlement decisions stay on the AegisTrans backend. */
@CapacitorPlugin(name = "Iap")
public class IapPlugin extends Plugin implements PurchasesUpdatedListener {
    private static final String MONTHLY = "com.aegisrd.aegistrans.pro.monthly";
    private static final String YEARLY = "com.aegisrd.aegistrans.pro.yearly";
    private static final String LIFETIME = "com.aegisrd.aegistrans.pro.lifetime";

    private BillingClient billingClient;
    private final Map<String, ProductDetails> productCache = new HashMap<>();
    private final List<QueuedCall> readyQueue = new ArrayList<>();
    private PluginCall pendingPurchaseCall;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
            .enableAutoServiceReconnection()
            .build();
        connect();
    }

    /** queued API call：帶著 PluginCall，setup 失敗時可逐一 reject（review 2026-07-20 #5 —
     *  舊版只 reject pendingPurchaseCall，排隊中的 getProducts/restore/finishTransaction 的
     *  call 永遠不 resolve → JS promise 永遠 hang，restore spinner 轉不停）。 */
    private static final class QueuedCall {
        final PluginCall call;
        final Runnable work;
        QueuedCall(PluginCall call, Runnable work) { this.call = call; this.work = work; }
    }

    private synchronized void connect() {
        if (billingClient == null || billingClient.isReady() || billingClient.getConnectionState() == BillingClient.ConnectionState.CONNECTING) return;
        billingClient.startConnection(new BillingClientStateListener() {
            @Override public void onBillingSetupFinished(@NonNull BillingResult result) {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    rejectReadyQueue("Play Billing unavailable: " + result.getDebugMessage());
                    return;
                }
                List<QueuedCall> work;
                synchronized (IapPlugin.this) {
                    work = new ArrayList<>(readyQueue);
                    readyQueue.clear();
                }
                for (QueuedCall item : work) item.work.run();
            }
            @Override public void onBillingServiceDisconnected() {
                // Automatic reconnection is enabled. The next API request reconnects.
            }
        });
    }

    private synchronized void whenReady(PluginCall call, Runnable work) {
        if (billingClient != null && billingClient.isReady()) {
            work.run();
            return;
        }
        readyQueue.add(new QueuedCall(call, work));
        connect();
    }

    private synchronized void rejectReadyQueue(String message) {
        // review P3：pendingPurchaseCall 在「billing 未就緒時發起購買」時同時也在 readyQueue
        // （purchase() 先佔 slot、再 whenReady→入列 = 同一個 call 兩處都有）。下面 queue loop 會
        // reject 它一次；若不排除，pendingPurchaseCall 區塊會對同一 call 二次 reject —— Capacitor
        // 對已消費的 call reject 會 throw，且原本這裡沒 try/catch → crash。故：queue 每筆 reject 一次、
        // pendingPurchaseCall 只在「不在 queue 裡」（已 launch、正等購買結果）時才 reject，全包 try/catch。
        PluginCall purchaseCall = pendingPurchaseCall;
        pendingPurchaseCall = null;
        boolean purchaseInQueue = false;
        for (QueuedCall q : readyQueue) {
            if (q.call == purchaseCall) purchaseInQueue = true;
            try { q.call.reject(message); } catch (Exception ignored) { }
        }
        readyQueue.clear();
        if (purchaseCall != null && !purchaseInQueue) {
            try { purchaseCall.reject(message); } catch (Exception ignored) { }
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        whenReady(call, () -> {
            JSObject out = new JSObject();
            out.put("available", true);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void getProducts(PluginCall call) {
        whenReady(call, () -> queryProducts(call));
    }

    private void queryProducts(PluginCall call) {
        JSArray output = new JSArray();
        AtomicInteger remaining = new AtomicInteger(2);
        AtomicBoolean failed = new AtomicBoolean(false);
        queryProductType(BillingClient.ProductType.SUBS, List.of(MONTHLY, YEARLY), output, remaining, failed, call);
        queryProductType(BillingClient.ProductType.INAPP, Collections.singletonList(LIFETIME), output, remaining, failed, call);
    }

    private void queryProductType(String type, List<String> ids, JSArray output, AtomicInteger remaining, AtomicBoolean failed, PluginCall call) {
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            products.add(QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(type).build());
        }
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder().setProductList(products).build();
        billingClient.queryProductDetailsAsync(params, (result, detailsResult) -> {
            if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                for (ProductDetails details : detailsResult.getProductDetailsList()) {
                    productCache.put(details.getProductId(), details);
                    output.put(toJsProduct(details));
                }
            } else {
                // review #5：Billing 暫時離線時回非 OK → 別 resolve 空陣列（會被誤讀成「沒商品」）。
                // 只 reject 一次，讓 JS 端能顯示「暫時無法連 Play」而非「沒有可購買項目」。
                if (failed.compareAndSet(false, true)) {
                    call.reject("Play query failed: " + result.getDebugMessage());
                }
            }
            if (remaining.decrementAndGet() == 0 && !failed.get()) {
                JSObject out = new JSObject();
                out.put("products", output);
                call.resolve(out);
            }
        });
    }

    private JSObject toJsProduct(ProductDetails details) {
        JSObject item = new JSObject();
        item.put("id", details.getProductId());
        item.put("displayName", details.getName());
        item.put("description", details.getDescription());
        item.put("type", details.getProductType().equals(BillingClient.ProductType.SUBS) ? "auto_renewable" : "non_consumable");

        if (details.getProductType().equals(BillingClient.ProductType.SUBS) && details.getSubscriptionOfferDetails() != null && !details.getSubscriptionOfferDetails().isEmpty()) {
            ProductDetails.SubscriptionOfferDetails offer = details.getSubscriptionOfferDetails().get(0);
            List<ProductDetails.PricingPhase> phases = offer.getPricingPhases().getPricingPhaseList();
            if (!phases.isEmpty()) {
                ProductDetails.PricingPhase phase = phases.get(phases.size() - 1);
                item.put("displayPrice", phase.getFormattedPrice());
                item.put("price", phase.getPriceAmountMicros() / 1_000_000.0);
                item.put("currencyCode", phase.getPriceCurrencyCode());
                item.put("subscriptionPeriod", phase.getBillingPeriod());
            }
        } else if (details.getOneTimePurchaseOfferDetails() != null) {
            ProductDetails.OneTimePurchaseOfferDetails offer = details.getOneTimePurchaseOfferDetails();
            item.put("displayPrice", offer.getFormattedPrice());
            item.put("price", offer.getPriceAmountMicros() / 1_000_000.0);
            item.put("currencyCode", offer.getPriceCurrencyCode());
        }
        return item;
    }

    @PluginMethod
    public synchronized void purchase(PluginCall call) {
        String productId = call.getString("productId");
        if (productId == null) {
            call.reject("productId required");
            return;
        }
        if (pendingPurchaseCall != null) {
            call.reject("Another purchase is already in progress");
            return;
        }
        // Reserve the purchase slot before BillingClient is ready; otherwise two quick taps can
        // both enter the ready queue and the second call replaces the first callback.
        pendingPurchaseCall = call;
        whenReady(call, () -> launchPurchase(call, productId));
    }

    private synchronized void launchPurchase(PluginCall call, String productId) {
        ProductDetails details = productCache.get(productId);
        if (details == null) {
            pendingPurchaseCall = null;
            call.reject("Product details not loaded: " + productId);
            return;
        }
        BillingFlowParams.ProductDetailsParams.Builder productParams = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details);
        if (details.getProductType().equals(BillingClient.ProductType.SUBS)) {
            List<ProductDetails.SubscriptionOfferDetails> offers = details.getSubscriptionOfferDetails();
            if (offers == null || offers.isEmpty()) {
                pendingPurchaseCall = null;
                call.reject("No eligible subscription offer: " + productId);
                return;
            }
            productParams.setOfferToken(offers.get(0).getOfferToken());
        }
        BillingFlowParams.Builder flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(Collections.singletonList(productParams.build()));
        String account = call.getString("appAccountToken");
        if (account != null && !account.isEmpty()) flow.setObfuscatedAccountId(account);
        BillingResult result = billingClient.launchBillingFlow(getActivity(), flow.build());
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
            pendingPurchaseCall = null;
            call.reject("Unable to start purchase: " + result.getDebugMessage());
        }
    }

    @Override
    public synchronized void onPurchasesUpdated(@NonNull BillingResult result, List<Purchase> purchases) {
        if (result.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            resolvePurchaseStatus("cancelled", null);
            return;
        }
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK || purchases == null || purchases.isEmpty()) {
            if (pendingPurchaseCall != null) {
                pendingPurchaseCall.reject("Purchase failed: " + result.getDebugMessage());
                pendingPurchaseCall = null;
            }
            return;
        }
        for (Purchase purchase : purchases) {
            if (purchase.getPurchaseState() == Purchase.PurchaseState.PENDING) {
                resolvePurchaseStatus("pending", purchase);
            } else if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                resolvePurchaseStatus("purchased", purchase);
            }
        }
    }

    private void resolvePurchaseStatus(String status, Purchase purchase) {
        JSObject out = purchasePayload(status, purchase);
        if (pendingPurchaseCall != null) {
            pendingPurchaseCall.resolve(out);
            pendingPurchaseCall = null;
        } else if (purchase != null) {
            notifyListeners("transactionUpdate", out);
        }
    }

    private JSObject purchasePayload(String status, Purchase purchase) {
        JSObject out = new JSObject();
        out.put("status", status);
        if (purchase != null) {
            String productId = purchase.getProducts().isEmpty() ? "" : purchase.getProducts().get(0);
            out.put("productId", productId);
            out.put("purchaseToken", purchase.getPurchaseToken());
            // TS 介面沿用 transactionId；Android 用 purchaseToken，後端驗證成功後拿它 acknowledge。
            out.put("transactionId", purchase.getPurchaseToken());
            out.put("productType", LIFETIME.equals(productId) ? "inapp" : "subs");
            out.put("acknowledged", purchase.isAcknowledged());
        }
        return out;
    }

    @PluginMethod
    public void restorePurchases(PluginCall call) {
        whenReady(call, () -> {
            JSArray items = new JSArray();
            AtomicInteger remaining = new AtomicInteger(2);
            AtomicBoolean failed = new AtomicBoolean(false);
            queryOwned(BillingClient.ProductType.SUBS, items, remaining, failed, call);
            queryOwned(BillingClient.ProductType.INAPP, items, remaining, failed, call);
        });
    }

    private void queryOwned(String type, JSArray items, AtomicInteger remaining, AtomicBoolean failed, PluginCall call) {
        QueryPurchasesParams params = QueryPurchasesParams.newBuilder().setProductType(type).build();
        billingClient.queryPurchasesAsync(params, (result, purchases) -> {
            if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                for (Purchase purchase : purchases) {
                    if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) items.put(purchasePayload("purchased", purchase));
                }
            } else {
                // review #5：Play 暫時離線回非 OK → reject（別靜默 resolve 空 → 誤報「沒有可恢復購買」）。
                if (failed.compareAndSet(false, true)) {
                    call.reject("Play restore query failed: " + result.getDebugMessage());
                }
            }
            if (remaining.decrementAndGet() == 0 && !failed.get()) {
                JSObject out = new JSObject();
                out.put("transactions", items);
                call.resolve(out);
            }
        });
    }

    @PluginMethod
    public void finishTransaction(PluginCall call) {
        String token = call.getString("transactionId");
        if (token == null || token.isEmpty()) {
            call.reject("transactionId required");
            return;
        }
        whenReady(call, () -> billingClient.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(),
            result -> {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK || result.getResponseCode() == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) call.resolve();
                else call.reject("Acknowledge failed: " + result.getDebugMessage());
            }
        ));
    }

    @Override
    protected void handleOnDestroy() {
        if (billingClient != null) billingClient.endConnection();
        super.handleOnDestroy();
    }
}
