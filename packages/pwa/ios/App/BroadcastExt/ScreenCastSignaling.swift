//
//  ScreenCastSignaling.swift
//  AegisTrans — 螢幕投放 app↔Broadcast-Extension 信令橋
//
//  ⚠️ 這個檔在兩個 build unit 各一份（內容必須一致）：
//     - packages/aegis-display/ios/Plugin/ScreenCastSignaling.swift   (主 App / Capacitor plugin)
//     - packages/pwa/ios/App/BroadcastExt/ScreenCastSignaling.swift   (Broadcast Upload Extension)
//  改一邊要同步另一邊。
//
//  ⚠️ 儲存用「App Group 容器檔案」，不是 UserDefaults(suiteName:)。
//  原因：跨進程 UserDefaults 各進程有 CFPrefs 快取，一端寫、另一端讀到舊快取空值
//  (實測 log 出現 "Contents Need Refresh" + "found no value")。檔案式 + 每次重讀
//  才可靠。低頻信令(offer/answer/少量 ICE)用檔案完全夠。
//
//  Darwin notification(跨進程、無 payload)只當「有新資料」的鈴；資料在 App Group 檔。
//

import Foundation

enum ScreenCastSignaling {
    static let appGroup = "group.com.aegisrd.aegistrans"

    // Darwin notification 名
    static let nOffer    = "com.aegisrd.aegistrans.screen.offer"     // ext → app
    static let nIceToApp = "com.aegisrd.aegistrans.screen.iceToApp"  // ext → app
    static let nState    = "com.aegisrd.aegistrans.screen.state"     // ext → app
    static let nAnswer   = "com.aegisrd.aegistrans.screen.answer"    // app → ext
    static let nIceToExt = "com.aegisrd.aegistrans.screen.iceToExt"  // app → ext
    static let nStop     = "com.aegisrd.aegistrans.screen.stop"      // app → ext

    // 檔名(= 邏輯 key)
    static let kPeerPubkey = "screencast.peer"
    static let kOfferSdp   = "screencast.offer"
    static let kAnswerSdp  = "screencast.answer"
    static let kState      = "screencast.state"
    static let kIceToApp   = "screencast.iceToApp"  // 每行一個 ICE JSON
    static let kIceToExt   = "screencast.iceToExt"

    private static let allKeys = [kPeerPubkey, kOfferSdp, kAnswerSdp, kState, kIceToApp, kIceToExt]

    /// App Group 共用容器目錄(entitlement 沒掛 → nil)
    static var containerDir: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    private static func fileURL(_ key: String) -> URL? {
        containerDir?.appendingPathComponent(key)
    }

    // MARK: - 字串讀寫(offer/answer/peer/state)

    static func setString(_ key: String, _ value: String?) {
        guard let url = fileURL(key) else { return }
        if let value = value {
            try? value.data(using: .utf8)?.write(to: url, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    static func getString(_ key: String) -> String? {
        guard let url = fileURL(key), let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - ICE(newline-delimited，append + read-and-clear)

    static func appendIce(_ key: String, _ iceJson: String) {
        guard let url = fileURL(key) else { return }
        let line = iceJson + "\n"
        if FileManager.default.fileExists(atPath: url.path),
           let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8) ?? Data())
            try? handle.close()
        } else {
            try? line.data(using: .utf8)?.write(to: url, options: .atomic)
        }
    }

    /// 讀走所有 ICE 並刪檔(read-and-clear；重複 addIceCandidate 對 WebRTC 無害)
    static func drainIce(_ key: String) -> [String] {
        guard let url = fileURL(key), let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else { return [] }
        try? FileManager.default.removeItem(at: url)
        return text.split(separator: "\n").map(String.init)
    }

    /// 清掉一輪投放的所有殘留(開始新一輪前)
    static func reset() {
        for key in allKeys { if let url = fileURL(key) { try? FileManager.default.removeItem(at: url) } }
    }

    // MARK: - Darwin notification

    static func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name as CFString),
            nil, nil, true)
    }

    // MARK: - Debug log(寫進 App Group 容器，事後用 devicectl 拉出來讀；NSLog 在 extension 不可靠)

    // 序列化檔案 append(多執行緒同時寫會掉行/交錯 → onicecandidate 在 WebRTC 執行緒、
    // broadcastStarted 在 main,之前就掉過 "local ICE posted" 那幾行)
    private static let debugQueue = DispatchQueue(label: "screencast.debug")

    static func debug(_ tag: String, _ msg: String) {
        NSLog("[ScreenCast] %@ %@", tag, msg)
        guard let url = containerDir?.appendingPathComponent("screencast.debug.log") else { return }
        let line = "\(Date().timeIntervalSince1970) [\(tag)] \(msg)\n"
        debugQueue.sync {
            if FileManager.default.fileExists(atPath: url.path),
               let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(line.data(using: .utf8) ?? Data())
                try? handle.close()
            } else {
                try? line.data(using: .utf8)?.write(to: url, options: .atomic)
            }
        }
    }

    static func clearDebug() {
        guard let url = containerDir?.appendingPathComponent("screencast.debug.log") else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

// MARK: - Darwin 觀察者（CFNotificationCenter C callback → Swift closure registry）

private final class DarwinObserverRegistry {
    static let shared = DarwinObserverRegistry()
    private var handlers: [String: () -> Void] = [:]
    private let lock = NSLock()

    func set(_ name: String, _ handler: @escaping () -> Void) {
        lock.lock(); handlers[name] = handler; lock.unlock()
    }
    func remove(_ name: String) {
        lock.lock(); handlers.removeValue(forKey: name); lock.unlock()
    }
    func fire(_ name: String) {
        lock.lock(); let h = handlers[name]; lock.unlock()
        if let h = h { DispatchQueue.main.async { h() } }
    }
}

private func screenCastDarwinCallback(
    _ center: CFNotificationCenter?,
    _ observer: UnsafeMutableRawPointer?,
    _ name: CFNotificationName?,
    _ object: UnsafeRawPointer?,
    _ userInfo: CFDictionary?
) {
    guard let name = name?.rawValue as String? else { return }
    DarwinObserverRegistry.shared.fire(name)
}

@discardableResult
func observeDarwin(_ name: String, _ handler: @escaping () -> Void) -> () -> Void {
    DarwinObserverRegistry.shared.set(name, handler)
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterAddObserver(
        center,
        nil,
        screenCastDarwinCallback,
        name as CFString,
        nil,
        .deliverImmediately)
    return {
        CFNotificationCenterRemoveObserver(center, nil, CFNotificationName(name as CFString), nil)
        DarwinObserverRegistry.shared.remove(name)
    }
}
