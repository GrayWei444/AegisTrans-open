//
//  AegisDisplayPlugin.swift
//  @aegisrd/capacitor-aegisdisplay — iOS native impl
//
//  職責（iOS）：
//   - 螢幕「投放發送」(startScreenSend …)：觸發系統 Broadcast picker 啟動 Broadcast Upload
//     Extension（真正的擷取 + RTCPeerConnection 在 extension 進程，見 BroadcastExt/SampleHandler.swift）；
//     本 plugin 只當「JS ↔ extension」的信令橋（App Group + Darwin notification）。
//   - 虛擬螢幕 / captureScreen：iOS 不支援（桌面才有）。回傳 not-supported，與舊 web fallback 行為一致，
//     避免 DeviceListSidebar 啟動時呼叫 getVirtualDisplayStatus() 被 reject。
//
//  信令流（sender 端）：
//   JS startScreenSend(peer) → 本 plugin 寫 peerPubkey 進 App Group + 跳 broadcast picker
//   extension 啟動 → 建 PC → 產 offer → 寫 App Group + post Darwin nOffer
//   本 plugin 收 nOffer → 讀 offer → notifyListeners("screenSendLocalDescription") → JS 發 MQTT
//   JS 收 answer → setScreenSendRemoteDescription → 本 plugin 寫 App Group + post nAnswer → extension 套用
//   ICE 雙向同理（nIceToApp / nIceToExt）。
//

import Foundation
import Capacitor
import ReplayKit

@objc(AegisDisplayPlugin)
public class AegisDisplayPlugin: CAPPlugin {

    /// extension 的 bundle id（RPSystemBroadcastPickerView.preferredExtension）
    private let broadcastExtensionId = "com.aegisrd.aegistrans.broadcast"

    private var darwinCancels: [() -> Void] = []
    private var isSending = false
    // 預先建立的 broadcast picker:讓 iOS 提早探索 broadcast extension,避免首次投放冷啟動
    // 要點兩三次才叫得起系統直播表單。在裝置頁載入(getVirtualDisplayStatus)時建一次。
    private var prewarmPicker: RPSystemBroadcastPickerView?
    // 投放開始後主 App 會被背景暫停 → Darwin observer 收不到 extension 的 offer/ICE 鈴。
    // 用 background task 讓主 App 在「握手期間」保持存活,把 offer/answer/ICE 經 MQTT 轉完;
    // 連上(connected)後放手,之後媒體在 extension 自己跑,主 App 暫停也沒差。
    private var bgTask: UIBackgroundTaskIdentifier = .invalid

    // MARK: - 虛擬螢幕 / captureScreen（iOS 不支援，回傳與 web fallback 一致）

    @objc func captureScreen(_ call: CAPPluginCall) {
        // iOS 螢幕投放走原生 startScreenSend，不走 JS captureScreen。回 null（取消語意）。
        call.resolve()
    }

    @objc func getVirtualDisplayStatus(_ call: CAPPluginCall) {
        // 裝置頁載入時會呼叫此 method → 順手預建 broadcast picker 暖機(探索 extension),
        // 讓使用者首次點「投放螢幕」就能一次叫起系統直播表單(冷啟動修正)。
        prewarmBroadcastPicker()
        call.resolve([
            "supported": false,
            "enabled": false,
            "reason": "Virtual display not supported on iOS",
        ])
    }

    /// 預建一個隱藏的 broadcast picker(只建不點),讓 iOS 提早載入/探索 broadcast extension。
    private func prewarmBroadcastPicker() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.prewarmPicker == nil else { return }
            let picker = RPSystemBroadcastPickerView(frame: CGRect(x: -200, y: -200, width: 1, height: 1))
            picker.preferredExtension = self.broadcastExtensionId
            picker.showsMicrophoneButton = false
            if let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first {
                window.addSubview(picker)
                picker.layoutIfNeeded()
                self.prewarmPicker = picker
                ScreenCastSignaling.debug("PLUGIN", "prewarm picker created")
            }
        }
    }

    @objc func enableVirtualDisplay(_ call: CAPPluginCall) {
        call.reject("enableVirtualDisplay not supported on iOS")
    }

    @objc func disableVirtualDisplay(_ call: CAPPluginCall) {
        call.resolve(["supported": false, "enabled": false])
    }

    // MARK: - 螢幕投放發送

    @objc func startScreenSend(_ call: CAPPluginCall) {
        guard let peer = call.getString("peerPubkey"), !peer.isEmpty else {
            call.reject("peerPubkey required")
            return
        }
        ScreenCastSignaling.clearDebug()
        ScreenCastSignaling.debug("PLUGIN","startScreenSend peer=\(peer) appGroup=\(ScreenCastSignaling.containerDir == nil ? "NIL" : "ok")")

        // 清掉上一輪殘留，寫入本輪目標 peer，讓 extension 啟動時讀得到
        ScreenCastSignaling.reset()
        ScreenCastSignaling.setString(ScreenCastSignaling.kPeerPubkey, peer)

        // 註冊 extension → app 的 Darwin 鈴
        teardownObservers()
        darwinCancels.append(observeDarwin(ScreenCastSignaling.nOffer) { [weak self] in
            self?.forwardOfferToJS()
        })
        darwinCancels.append(observeDarwin(ScreenCastSignaling.nIceToApp) { [weak self] in
            self?.forwardIceToJS()
        })
        darwinCancels.append(observeDarwin(ScreenCastSignaling.nState) { [weak self] in
            self?.forwardStateToJS()
        })
        isSending = true

        // 跳系統 broadcast picker（使用者點「開始直播」才會啟動 extension）
        DispatchQueue.main.async { [weak self] in
            self?.beginBg()
            self?.presentBroadcastPicker()
            call.resolve()
        }
    }

    private func beginBg() {
        endBg()
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "ScreenCastHandshake") { [weak self] in
            ScreenCastSignaling.debug("PLUGIN", "background task expiring")
            self?.endBg()
        }
        ScreenCastSignaling.debug("PLUGIN", "beginBackgroundTask id=\(bgTask.rawValue)")
    }

    private func endBg() {
        if bgTask != .invalid {
            UIApplication.shared.endBackgroundTask(bgTask)
            bgTask = .invalid
        }
    }

    @objc func setScreenSendRemoteDescription(_ call: CAPPluginCall) {
        guard let sdp = call.getString("sdp") else { call.reject("sdp required"); return }
        ScreenCastSignaling.setString(ScreenCastSignaling.kAnswerSdp, sdp)
        ScreenCastSignaling.post(ScreenCastSignaling.nAnswer)
        call.resolve()
    }

    @objc func addScreenSendIceCandidate(_ call: CAPPluginCall) {
        guard let candidate = call.getString("candidate") else { call.reject("candidate required"); return }
        let ice: [String: Any] = [
            "candidate": candidate,
            "sdpMid": call.getString("sdpMid") as Any,
            "sdpMLineIndex": call.getInt("sdpMLineIndex") as Any,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: ice),
           let json = String(data: data, encoding: .utf8) {
            ScreenCastSignaling.appendIce(ScreenCastSignaling.kIceToExt, json)
            ScreenCastSignaling.post(ScreenCastSignaling.nIceToExt)
        }
        call.resolve()
    }

    @objc func stopScreenSend(_ call: CAPPluginCall) {
        ScreenCastSignaling.post(ScreenCastSignaling.nStop)
        teardownObservers()
        endBg()
        isSending = false
        call.resolve()
    }

    // MARK: - extension → JS 轉發

    private func forwardOfferToJS() {
        guard let sdp = ScreenCastSignaling.getString(ScreenCastSignaling.kOfferSdp) else {
            ScreenCastSignaling.debug("PLUGIN","forwardOfferToJS: nOffer fired but no offer file"); return
        }
        ScreenCastSignaling.debug("PLUGIN","forwardOfferToJS: emit offer to JS \(sdp.count) chars")
        notifyListeners("screenSendLocalDescription", data: ["sdp": sdp, "type": "offer"])
    }

    private func forwardIceToJS() {
        let items = ScreenCastSignaling.drainIce(ScreenCastSignaling.kIceToApp)
        for json in items {
            guard let data = json.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let candidate = obj["candidate"] as? String else { continue }
            notifyListeners("screenSendIceCandidate", data: [
                "candidate": candidate,
                "sdpMid": obj["sdpMid"] as? String as Any,
                "sdpMLineIndex": obj["sdpMLineIndex"] as? Int as Any,
            ])
        }
    }

    private func forwardStateToJS() {
        let state = ScreenCastSignaling.getString(ScreenCastSignaling.kState) ?? "unknown"
        ScreenCastSignaling.debug("PLUGIN","forwardStateToJS: state=\(state)")
        notifyListeners("screenSendState", data: ["state": state])
        // 握手完成(連上)或結束 → 放掉 background task
        if state == "connected" || state == "failed" || state == "ended" {
            endBg()
        }
    }

    // MARK: - Broadcast picker

    private func presentBroadcastPicker() {
        // 優先用「已暖機」的 picker(getVirtualDisplayStatus 在裝置頁載入時預建,iOS 已探索好
        // extension + 已 layout)→ 第一次點就叫得起系統直播表單。沒有才現建一個。
        if let warm = prewarmPicker {
            tapPickerButton(warm, persistent: true)
            return
        }
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        picker.preferredExtension = broadcastExtensionId
        picker.showsMicrophoneButton = false
        if let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow }) ?? UIApplication.shared.windows.first {
            window.addSubview(picker)
            picker.layoutIfNeeded()
            tapPickerButton(picker, persistent: false)
        } else {
            ScreenCastSignaling.debug("PLUGIN","presentBroadcastPicker: NO key window")
        }
    }

    /// 延一拍遞迴找 picker 內部 UIButton 點擊(觸發系統直播表單)。persistent=false 的拋棄式 picker 5s 後移除。
    private func tapPickerButton(_ picker: RPSystemBroadcastPickerView, persistent: Bool) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            func findButton(_ v: UIView) -> UIButton? {
                if let b = v as? UIButton { return b }
                for s in v.subviews { if let b = findButton(s) { return b } }
                return nil
            }
            let btn = findButton(picker)
            btn?.sendActions(for: .touchUpInside)
            ScreenCastSignaling.debug("PLUGIN","picker tapped=\(btn != nil ? "yes" : "NO-BUTTON") warm=\(persistent)")
            if !persistent {
                DispatchQueue.main.asyncAfter(deadline: .now() + 5.0) { picker.removeFromSuperview() }
            }
        }
    }

    private func teardownObservers() {
        darwinCancels.forEach { $0() }
        darwinCancels = []
    }

    deinit {
        teardownObservers()
    }
}
