//
//  AegisFileStreamPlugin.swift
//  AegisTrans iOS — >2GB stream-to-disk 原生層（與 Electron main 的 fstream / Android plugin 同構）。
//
//  收檔：renderer 每收一個解密 chunk 就 write(fileId, offset, base64) → FileHandle
//  seek+write random-access 落盤（chunk 亂序到達天然安全）。finalize 驗 size + CryptoKit
//  串流 SHA-256，過了才 rename 到 Documents/aegistrans-files/<fileId>-<name>。
//
//  記憶體紀律（HANDOFF 使用者交代）：任何方法只碰單一 chunk，native 端絕不 accumulate；
//  SHA-256 用 1MB buffer 串流讀檔算（autoreleasepool 包住），不載整檔進 RAM。
//
//  所有預期錯誤 resolve {ok:false, error}（對齊 Electron 介面）；reject 只留給參數缺失。
//  全部操作走單一 serial queue：seek+write 必須原子（Capacitor 呼叫可能並發），
//  也保護 handles dict（Electron main 亦是 promise chain 序列化）。
//

import Foundation
import Capacitor
import CryptoKit

@objc(AegisFileStreamPlugin)
public class AegisFileStreamPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AegisFileStreamPlugin"
    public let jsName = "AegisFileStream"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finalize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipeAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "freeBytes", returnType: CAPPluginReturnPromise),
    ]

    private var handles: [String: FileHandle] = [:]
    private let queue = DispatchQueue(label: "com.aegisrd.aegistrans.fstream")

    private func dir() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("aegistrans-files", isDirectory: true)
    }

    private func tmpURL(_ fileId: String) -> URL {
        dir().appendingPathComponent(".tmp-" + fileId)
    }

    /// fileId 是我們自己生的 UUID，防禦性擋路徑穿越。
    private static func badId(_ fileId: String?) -> Bool {
        guard let id = fileId, !id.isEmpty else { return true }
        return id.contains("/") || id.contains("\\") || id.contains("..")
    }

    /// path 必須落在 aegistrans-files/ 內（read/stat/delete 只服務自家收的檔）。
    private func insideDir(_ path: String) -> Bool {
        let base = dir().standardizedFileURL.path
        let target = URL(fileURLWithPath: path).standardizedFileURL.path
        return target.hasPrefix(base + "/")
    }

    private static func err(_ call: CAPPluginCall, _ message: String) {
        call.resolve(["ok": false, "error": message])
    }

    // MARK: - open

    @objc func open(_ call: CAPPluginCall) {
        guard let fileId = call.getString("fileId"), !Self.badId(fileId) else { call.reject("fileId required"); return }
        queue.async {
            do {
                if let prev = self.handles.removeValue(forKey: fileId) { try? prev.close() }
                try FileManager.default.createDirectory(at: self.dir(), withIntermediateDirectories: true)
                let tmp = self.tmpURL(fileId)
                if FileManager.default.fileExists(atPath: tmp.path) {
                    try FileManager.default.removeItem(at: tmp)
                }
                FileManager.default.createFile(atPath: tmp.path, contents: nil)
                self.handles[fileId] = try FileHandle(forWritingTo: tmp)
                call.resolve(["ok": true])
            } catch {
                Self.err(call, "open: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - write（單 chunk random-access 落盤；base64 → Data 解一次即寫，不 accumulate）

    @objc func write(_ call: CAPPluginCall) {
        guard let fileId = call.getString("fileId"), !Self.badId(fileId),
              let offset = call.getDouble("offset"),
              let b64 = call.getString("data") else { call.reject("fileId/offset/data required"); return }
        // 防禦：負值/NaN/非整數 offset 直接 UInt64(offset) 會 runtime trap（無法 catch → crash）。
        // JS 端已驗 chunkIndex，這是深度防禦（review 2026-07-20 #4）。
        guard offset >= 0, offset.isFinite, offset <= Double(UInt64.max) else { Self.err(call, "bad offset"); return }
        queue.async {
            guard let fh = self.handles[fileId] else { Self.err(call, "not open"); return }
            guard let data = Data(base64Encoded: b64) else { Self.err(call, "bad base64"); return }
            do {
                try fh.seek(toOffset: UInt64(offset))
                try fh.write(contentsOf: data)
                call.resolve(["ok": true])
            } catch {
                Self.err(call, "write: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - finalize（size 驗證 + CryptoKit 串流 SHA-256 + rename 正式路徑）

    @objc func finalize(_ call: CAPPluginCall) {
        guard let fileId = call.getString("fileId"), !Self.badId(fileId),
              let sha256 = call.getString("sha256"),
              let size = call.getDouble("size"),
              let name = call.getString("name") else { call.reject("fileId/sha256/size/name required"); return }
        queue.async {
            let tmp = self.tmpURL(fileId)
            do {
                if let fh = self.handles.removeValue(forKey: fileId) { try fh.close() }
                let attrs = try FileManager.default.attributesOfItem(atPath: tmp.path)
                let actual = (attrs[.size] as? NSNumber)?.int64Value ?? -1
                guard actual == Int64(size) else {
                    try? FileManager.default.removeItem(at: tmp)
                    Self.err(call, "size mismatch: \(actual) != \(Int64(size))")
                    return
                }
                let actualSha = try Self.sha256Hex(of: tmp)
                guard actualSha == sha256.lowercased() else {
                    try? FileManager.default.removeItem(at: tmp)
                    Self.err(call, "sha256 mismatch")
                    return
                }
                // 檔名去掉路徑分隔符（來自遠端 manifest，不可信任）；fileId 前綴保證不撞名
                let safeName = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")
                let dest = self.dir().appendingPathComponent(fileId + "-" + safeName)
                if FileManager.default.fileExists(atPath: dest.path) {
                    try FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.moveItem(at: tmp, to: dest)
                call.resolve(["ok": true, "path": dest.path])
            } catch {
                try? FileManager.default.removeItem(at: tmp)
                Self.err(call, "finalize: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - abort

    @objc func abort(_ call: CAPPluginCall) {
        guard let fileId = call.getString("fileId"), !Self.badId(fileId) else { call.reject("fileId required"); return }
        queue.async {
            if let fh = self.handles.removeValue(forKey: fileId) { try? fh.close() }
            try? FileManager.default.removeItem(at: self.tmpURL(fileId))
            call.resolve(["ok": true])
        }
    }

    // MARK: - read（發送端重啟續服；每 call 只讀單 chunk）

    @objc func read(_ call: CAPPluginCall) {
        guard let path = call.getString("path"),
              let offset = call.getDouble("offset"),
              let length = call.getInt("length") else { call.reject("path/offset/length required"); return }
        guard offset >= 0, offset.isFinite, offset <= Double(UInt64.max), length >= 0 else { call.reject("bad offset/length"); return }
        queue.async {
            guard self.insideDir(path) else { call.reject("path outside managed dir"); return }
            do {
                let fh = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
                defer { try? fh.close() }
                try fh.seek(toOffset: UInt64(offset))
                let data = try fh.read(upToCount: length) ?? Data()
                call.resolve(["data": data.base64EncodedString()])
            } catch {
                call.reject("read: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - stat

    @objc func stat(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("path required"); return }
        queue.async {
            var size: Int64 = 0
            var exists = false
            if self.insideDir(path),
               let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               (attrs[.type] as? FileAttributeType) == .typeRegular {
                exists = true
                size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
            }
            call.resolve(["exists": exists, "size": size])
        }
    }

    // MARK: - delete

    @objc func delete(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { call.reject("path required"); return }
        queue.async {
            guard self.insideDir(path) else { Self.err(call, "path outside managed dir"); return }
            do {
                if FileManager.default.fileExists(atPath: path) {
                    try FileManager.default.removeItem(atPath: path)
                }
                call.resolve(["ok": true])
            } catch {
                Self.err(call, "delete: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - wipeAll（換帳號 wipe — 跨帳號不可殘留大檔）

    @objc func wipeAll(_ call: CAPPluginCall) {
        queue.async {
            for (_, fh) in self.handles { try? fh.close() }
            self.handles.removeAll()
            var failed: [String] = []
            if let items = try? FileManager.default.contentsOfDirectory(at: self.dir(), includingPropertiesForKeys: nil) {
                for item in items where (try? FileManager.default.removeItem(at: item)) == nil {
                    failed.append(item.lastPathComponent)
                }
            }
            if failed.isEmpty { call.resolve(["ok": true]) }
            else { Self.err(call, "wipe incomplete: " + failed.joined(separator: " ")) }
        }
    }

    // MARK: - freeBytes（>2GB 收檔前空間預檢）

    @objc func freeBytes(_ call: CAPPluginCall) {
        queue.async {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let values = try? docs.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            call.resolve(["free": values?.volumeAvailableCapacityForImportantUsage ?? 0])
        }
    }

    // MARK: - SHA-256（1MB buffer 串流，autoreleasepool 防 Data 累積）

    private static func sha256Hex(of url: URL) throws -> String {
        let fh = try FileHandle(forReadingFrom: url)
        defer { try? fh.close() }
        var hasher = SHA256()
        while true {
            let done = try autoreleasepool { () -> Bool in
                guard let chunk = try fh.read(upToCount: 1024 * 1024), !chunk.isEmpty else { return true }
                hasher.update(data: chunk)
                return false
            }
            if done { break }
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
