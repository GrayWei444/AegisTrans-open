//
//  SampleHandler.swift
//  BroadcastExt — AegisTrans 螢幕投放 Broadcast Upload Extension
//
//  這個 extension 在「投放期間」是獨立常駐進程（主 App 退背景被暫停也不影響它），所以
//  螢幕投放的 RTCPeerConnection 放這裡 → 投放不會因離開 App 而中斷（Twilio 模式；
//  LiveKit 把 PC 放主 App 會在背景 30s~5min 斷，不可抄）。
//
//  記憶體 50MB 上限紀律：單向 H.264 硬編、只發不收（no subscribe/decode）、15fps cap。
//
//  信令：本 extension 不碰 MQTT（那在主 App JS）。SDP/ICE 經 App Group + Darwin notification
//  跟主 App plugin 交換（見 ScreenCastSignaling.swift）：
//    - 啟動讀 App Group 的 peerPubkey（只當 log / 健全性，實際路由由 JS 用）
//    - 建 PC → 產 offer → 寫 App Group offerSdp + post nOffer
//    - 收 nAnswer → 讀 answerSdp → setRemoteDescription
//    - 收 nIceToExt → drain → addIceCandidate
//    - 本地 ICE → 寫 iceToApp + post nIceToApp
//    - 連線狀態 → 寫 state + post nState
//    - 收 nStop / broadcastFinished → 關 PC
//

import ReplayKit
import WebRTC
import CoreMedia
import CoreVideo
import ImageIO

class SampleHandler: RPBroadcastSampleHandler {

    private var factory: RTCPeerConnectionFactory?
    private var pc: RTCPeerConnection?
    private var videoSource: RTCVideoSource?
    private var videoCapturer: RTCVideoCapturer?
    private var videoTrack: RTCVideoTrack?

    private var darwinCancels: [() -> Void] = []
    private var pcDelegate: PCDelegate?
    private var endingBroadcast = false        // 防 finishBroadcast 遞迴(.closed → teardown → .closed)
    private var disconnectWork: DispatchWorkItem?  // ICE disconnected 寬限計時器

    // fps cap（15fps）：靠時間戳節流，省 CPU / 記憶體 / 上行頻寬
    private var lastFrameNs: Int64 = 0
    private let minFrameIntervalNs: Int64 = 1_000_000_000 / 15
    private var loggedFirstFrame = false

    // MARK: - Broadcast lifecycle

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let storeOk = ScreenCastSignaling.containerDir != nil
        let peer = ScreenCastSignaling.getString(ScreenCastSignaling.kPeerPubkey) ?? "nil"
        ScreenCastSignaling.debug("EXT", "broadcastStarted ENTER appGroup=\(storeOk ? "ok" : "NIL") peer=\(peer)")
        setState("starting")
        setupWebRTC()
        observeApp()
        createOffer()
        ScreenCastSignaling.debug("EXT", "broadcastStarted DONE")
    }

    override func broadcastPaused() {}
    override func broadcastResumed() {}

    override func broadcastFinished() {
        ScreenCastSignaling.debug("EXT","broadcastFinished")
        setState("ended")
        teardown()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }  // 只發 video（不收音、省記憶體）
        guard let source = videoSource, let capturer = videoCapturer else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let ptsNs = Int64(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1e9)
        if ptsNs - lastFrameNs < minFrameIntervalNs { return }  // fps cap
        lastFrameNs = ptsNs

        let rotation = videoRotation(from: sampleBuffer)
        let rtcBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let frame = RTCVideoFrame(buffer: rtcBuffer, rotation: rotation, timeStampNs: ptsNs)
        source.capturer(capturer, didCapture: frame)
        if !loggedFirstFrame {
            loggedFirstFrame = true
            ScreenCastSignaling.debug("EXT","first frame \(CVPixelBufferGetWidth(pixelBuffer))x\(CVPixelBufferGetHeight(pixelBuffer))")
        }
    }

    // MARK: - WebRTC setup

    private func setupWebRTC() {
        RTCInitializeSSL()
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        // 偏好 H.264（VideoToolbox 硬編，省記憶體；VP8/VP9 軟編會吃爆 50MB）
        if let h264 = encoderFactory.supportedCodecs().first(where: { $0.name == kRTCVideoCodecH264Name }) {
            encoderFactory.preferredCodec = h264
        }
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        let factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
        self.factory = factory

        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.iceTransportPolicy = .all  // 純 STUN；不加 TURN ⇒ 不會有 relay candidate（純 P2P）
        config.iceServers = [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
            RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"]),
        ]
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        ScreenCastSignaling.debug("EXT","setupWebRTC: factory created")
        let delegate = PCDelegate(handler: self)
        self.pcDelegate = delegate
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: delegate) else {
            ScreenCastSignaling.debug("EXT","setupWebRTC: peerConnection nil FAIL")
            setState("failed"); return
        }
        self.pc = pc
        ScreenCastSignaling.debug("EXT","setupWebRTC: pc created")

        let source = factory.videoSource()
        self.videoSource = source
        self.videoCapturer = RTCVideoCapturer(delegate: source)
        let track = factory.videoTrack(with: source, trackId: "screen0")
        self.videoTrack = track

        let txInit = RTCRtpTransceiverInit()
        txInit.direction = .sendOnly
        // ⚠️ 必須帶 streamIds：否則 offer SDP 是 `a=msid:- screen0`(- = 無 MediaStream),
        // 接收端 RTCTrackEvent.streams 為空 → webrtc.ts ontrack 取不到 stream → 黑屏。
        // 桌面 sender 走 addTrack(track, streams:[stream]) 本來就有帶,行動原生這條要對齊。
        txInit.streamIds = ["screen"]
        let tx = pc.addTransceiver(with: track, init: txInit)

        // 限制上行 bitrate（避免螢幕高解析度爆頻寬 / 記憶體）
        if let sender = tx?.sender {
            let params = sender.parameters
            for enc in params.encodings {
                enc.maxBitrateBps = NSNumber(value: 2_500_000)  // 2.5 Mbps
                enc.maxFramerate = NSNumber(value: 15)
            }
            sender.parameters = params
        }
        ScreenCastSignaling.debug("EXT","setupWebRTC: transceiver added")
    }

    private func createOffer() {
        guard let pc = pc else { ScreenCastSignaling.debug("EXT","createOffer: no pc"); return }
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "false", "OfferToReceiveVideo": "false"],
            optionalConstraints: nil)
        pc.offer(for: constraints) { [weak self] sdp, error in
            guard let self = self, let sdp = sdp, error == nil else {
                ScreenCastSignaling.debug("EXT","createOffer FAILED: \(error?.localizedDescription ?? "nil sdp")")
                self?.setState("failed"); return
            }
            ScreenCastSignaling.debug("EXT","createOffer ok sdp=\(sdp.sdp.count) chars")
            pc.setLocalDescription(sdp) { err in
                guard err == nil else {
                    ScreenCastSignaling.debug("EXT","setLocalDescription FAILED: \(err!.localizedDescription)")
                    self.setState("failed"); return
                }
                ScreenCastSignaling.setString(ScreenCastSignaling.kOfferSdp, sdp.sdp)
                ScreenCastSignaling.post(ScreenCastSignaling.nOffer)
                ScreenCastSignaling.debug("EXT","offer written + posted nOffer")
                self.setState("connecting")
            }
        }
    }

    // MARK: - app → extension（answer / ICE / stop）

    private func observeApp() {
        darwinCancels.append(observeDarwin(ScreenCastSignaling.nAnswer) { [weak self] in
            self?.applyAnswer()
        })
        darwinCancels.append(observeDarwin(ScreenCastSignaling.nIceToExt) { [weak self] in
            self?.applyRemoteIce()
        })
        darwinCancels.append(observeDarwin(ScreenCastSignaling.nStop) { [weak self] in
            self?.finishBroadcast()
        })
    }

    private func applyAnswer() {
        guard let pc = pc, let sdp = ScreenCastSignaling.getString(ScreenCastSignaling.kAnswerSdp) else {
            ScreenCastSignaling.debug("EXT","applyAnswer: no pc/answer"); return
        }
        ScreenCastSignaling.debug("EXT","applyAnswer: got answer \(sdp.count) chars")
        let desc = RTCSessionDescription(type: .answer, sdp: sdp)
        pc.setRemoteDescription(desc) { [weak self] err in
            if let err = err { NSLog("[ScreenCast] setRemoteDescription(answer) failed: \(err)"); self?.setState("failed") }
        }
    }

    private func applyRemoteIce() {
        guard let pc = pc else { return }
        let drained = ScreenCastSignaling.drainIce(ScreenCastSignaling.kIceToExt)
        ScreenCastSignaling.debug("EXT", "applyRemoteIce: \(drained.count) candidate(s) from receiver")
        for json in drained {
            guard let data = json.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let candidate = obj["candidate"] as? String else { continue }
            let ice = RTCIceCandidate(
                sdp: candidate,
                sdpMLineIndex: (obj["sdpMLineIndex"] as? Int32) ?? 0,
                sdpMid: obj["sdpMid"] as? String)
            pc.add(ice) { err in if let err = err { NSLog("[ScreenCast] addIce failed: \(err)") } }
        }
    }

    // MARK: - extension → app（local ICE / state）

    fileprivate func onLocalIce(_ candidate: RTCIceCandidate) {
        let typ = candidate.sdp.components(separatedBy: "typ ").dropFirst().first?.prefix(while: { $0 != " " }) ?? "?"
        ScreenCastSignaling.debug("EXT", "onLocalIce typ=\(typ)")
        // 過濾 relay（理論上沒 TURN 不會有，雙保險：資料不過中繼）
        if candidate.sdp.contains("typ relay") { return }
        let ice: [String: Any] = [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid as Any,
            "sdpMLineIndex": Int(candidate.sdpMLineIndex),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: ice),
           let str = String(data: data, encoding: .utf8) {
            ScreenCastSignaling.appendIce(ScreenCastSignaling.kIceToApp, str)
            ScreenCastSignaling.post(ScreenCastSignaling.nIceToApp)
            ScreenCastSignaling.debug("EXT","local ICE posted nIceToApp")
        }
    }

    fileprivate func onConnectionState(_ state: RTCIceConnectionState) {
        ScreenCastSignaling.debug("EXT","ICE state=\(state.rawValue)")
        switch state {
        case .connected, .completed:
            disconnectWork?.cancel(); disconnectWork = nil
            setState("connected")
        case .failed:
            // 接收端關閉 PC / 連線失敗 → extension 是投放期間唯一活著的進程,主 App 多半已被
            // iOS 暫停(收不到 MQTT SCREEN_SHARE_END)→ 必須由 extension 自己結束廣播。
            ScreenCastSignaling.debug("EXT","ICE failed → finishBroadcast")
            setState("failed"); finishBroadcast()
        case .disconnected:
            // disconnected 可能短暫抖動;給 3s 寬限,沒回 connected 就結束(單向投放不 renegotiate)。
            disconnectWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                ScreenCastSignaling.debug("EXT","ICE still disconnected after grace → finishBroadcast")
                self?.setState("ended"); self?.finishBroadcast()
            }
            disconnectWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
        case .closed:
            // 自身 teardown 觸發,不再 finishBroadcast(避免遞迴)
            setState("ended")
        default: break
        }
    }

    private func setState(_ s: String) {
        ScreenCastSignaling.setString(ScreenCastSignaling.kState, s)
        ScreenCastSignaling.post(ScreenCastSignaling.nState)
    }

    private func finishBroadcast() {
        if endingBroadcast { return }
        endingBroadcast = true
        // 通知系統結束 broadcast（會走 broadcastFinished → teardown）
        // iOS 在 app 程式化結束直播時必彈系統對話框(無法抑制);訊息用中文友善化。
        let err = NSError(domain: "AegisTrans", code: 0,
                          userInfo: [NSLocalizedDescriptionKey: "螢幕投放已結束"])
        finishBroadcastWithError(err)
    }

    private func teardown() {
        disconnectWork?.cancel(); disconnectWork = nil
        darwinCancels.forEach { $0() }
        darwinCancels = []
        videoTrack = nil
        videoCapturer = nil
        videoSource = nil
        pc?.close()
        pc = nil
        factory = nil
        pcDelegate = nil
        RTCCleanupSSL()
    }

    // ReplayKit sample buffer 的方向 → RTCVideoRotation
    // milestone 1：固定 ._0（直立投放可動）。橫向自動轉向用 ReplayKit 的
    // orientation attachment(RPVideoSampleBufferAttachmentKey 符號在不同 SDK 形式不一),
    // 列為後續微調,先不卡 build。
    private func videoRotation(from sampleBuffer: CMSampleBuffer) -> RTCVideoRotation {
        // 用 raw CFString key 讀方向(避開不穩定的 typed 符號);讀不到就 ._0。
        let key = "RPVideoSampleBufferAttachmentKey_videoOrientation" as CFString
        if let attachment = CMGetAttachment(sampleBuffer, key: key, attachmentModeOut: nil) as? NSNumber,
           let orientation = CGImagePropertyOrientation(rawValue: attachment.uint32Value) {
            switch orientation {
            case .up, .upMirrored: return ._0
            case .down, .downMirrored: return ._180
            case .left, .leftMirrored: return ._90
            case .right, .rightMirrored: return ._270
            @unknown default: return ._0
            }
        }
        return ._0
    }
}

// MARK: - RTCPeerConnectionDelegate（轉發 local ICE + 連線狀態）

private class PCDelegate: NSObject, RTCPeerConnectionDelegate {
    weak var handler: SampleHandler?
    init(handler: SampleHandler) { self.handler = handler }

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        handler?.onLocalIce(candidate)
    }
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        handler?.onConnectionState(newState)
    }
    // 其餘 delegate method（unified-plan 下多數可空實作）
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        ScreenCastSignaling.debug("EXT", "ICE gathering state=\(newState.rawValue)")
    }
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
