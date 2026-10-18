/**
 * MediaChannel — 跨裝置媒體串流管理（Phase 2 — 跨裝置協同擴展）
 *
 * 職責：
 *   - 在 webrtc.ts 既有 PeerConnection 上 addTrack / removeTrack（不另開 PC）
 *   - 接收 webrtc.ts 廣播的 ontrack 事件 → cache 遠端 MediaStream → 通知 listener
 *   - 提供 broadcast helper：對「所有已連 peer」一次 attach 同一支 stream
 *
 * 不負責的：
 *   - 螢幕擷取（getDisplayMedia）— 那是 source 端 UI 邏輯（screenSharePage.tsx）
 *   - 信令（screen-share-offer/answer）— 那是 mqtt.ts + screenShareController 的事
 *   - WebRTC 連線本身（那是 webrtc.ts）
 *
 * 為什麼分離 webrtc.ts vs mediaChannel.ts：
 *   webrtc.ts 是 transport-only，只懂 DataChannel + PeerConnection lifecycle，
 *   不解析 stream 內容；mediaChannel.ts 是 video/audio domain，知道哪台 peer
 *   現在收到什麼 stream、哪些 senders 對應哪台 peer。Domain 切開讓 webrtc.ts
 *   能繼續被 file transfer 那條路用，跟媒體解耦。
 *
 * Phase 2 Step 6.1（本檔）：純 transport API skeleton。
 * Phase 2 Step 6.3-6.4 會把這層 wire 進螢幕分享 sender / receiver UI。
 */

import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { webrtcService } from './webrtc';

type RemoteStreamCallback = (peerPubkeyBase64: string, stream: MediaStream) => void;
type RemoteStreamEndedCallback = (peerPubkeyBase64: string) => void;

class MediaChannelService {
  /** 每台 peer 我這邊推出去的 RTCRtpSender — detach 時用來找對應 transceiver 做 stop()。
   *  Bug 背景:removeTrack 不釋放 transceiver(只把 sender.track 設 null,m-section 留著)。
   *  連按兩次分享會疊加兩條 video transceiver,第二條被第一條死殼搶 encoder/BWE 資源 →
   *  第二次 session fps 掉到 1-2(不分 mirror/extend/平台)。解法:detach 用 transceiver.stop()
   *  徹底釋放舊 transceiver,下次 addTrack 是唯一 active transceiver。 */
  private localSenders: Map<string, RTCRtpSender[]> = new Map();
  /** 每台 peer 收到的最後一條遠端 MediaStream */
  private remoteStreams: Map<string, MediaStream> = new Map();
  /** 註冊的 stream-arrived listeners */
  private remoteStreamListeners: Set<RemoteStreamCallback> = new Set();
  /** 註冊的 stream-ended listeners（peer 那邊 removeTrack / 整條 PC 關閉） */
  private remoteStreamEndedListeners: Set<RemoteStreamEndedCallback> = new Set();
  /** webrtc.onMediaStream 的取消訂閱 fn */
  private webrtcUnsub: (() => void) | null = null;
  private initialized = false;

  /** Receiver-side getStats polling — 用來量「decoder / network 真的收到 / decoded 的 frame 速率」
   *  跟 sender 的 outbound-rtp.framesPerSecond 對比,定位瓶頸是 sender encoder / network / receiver decoder */
  private receiverStatsIntervals: Map<string, any> = new Map();
  /** receiver-side delta state — per-(peer, SSRC) for multi-stream/simulcast support。
   *  上一輪只抓 last-wins inbound-rtp 結果可能挑到跨 renegotiation 殘留 / 別條 SSRC,
   *  誤判「receiver 0 bitrate」。改 enumerate all + per-SSRC tracking。 */
  private receiverStatsPrev: Map<string, Map<number, {
    bytesReceived: number;
    framesDecoded: number;
    framesDropped: number;
    packetsLost: number;
    framesReceived: number;
    timestamp: number;
  }>> = new Map();

  /**
   * 初始化：訂閱 webrtc.ts 的 ontrack 廣播。idempotent。
   * 由 App.tsx 在 identity ready 後呼叫一次（同 webrtcService.initialize 時機）。
   */
  initialize(): void {
    if (this.initialized) return;
    this.webrtcUnsub = webrtcService.onMediaStream((peerPubkey, stream) => {
      this.handleRemoteStream(peerPubkey, stream);
    });
    this.initialized = true;
    diagLog('[DIAG:Media] Service initialized — subscribed to webrtc.onMediaStream');
  }

  shutdown(): void {
    if (this.webrtcUnsub) {
      this.webrtcUnsub();
      this.webrtcUnsub = null;
    }
    // 砍所有 local senders（如果還沒 detach）— detach 內部會 transceiver.stop() + 刪 map entry
    for (const peerPk of Array.from(this.localSenders.keys())) {
      this.detachLocalStream(peerPk);
    }
    this.localSenders.clear();
    // 砍所有 receiver stats polling intervals
    for (const peerPk of Array.from(this.receiverStatsIntervals.keys())) {
      this.stopReceiverStatsPolling(peerPk);
    }
    this.remoteStreams.clear();
    this.remoteStreamListeners.clear();
    this.remoteStreamEndedListeners.clear();
    this.initialized = false;
    devLog('[Media] Service shut down');
  }

  // ============================================
  // Local stream → peer（addTransceiver sendonly 路徑）
  // ============================================

  /**
   * 把 local MediaStream 推給指定 peer。
   *
   * Returns true if PC available + tracks added; false if peer not connected yet.
   *
   * **注意**：本 method 只負責 track wiring(addTransceiver sendonly);caller 還必須在自己側
   * createOffer 並透過 MQTT SCREEN_SHARE_OFFER 走 renegotiation 給對方。
   */
  attachLocalStream(peerPubkeyBase64: string, stream: MediaStream): boolean {
    const pc = webrtcService.getPeerConnection(peerPubkeyBase64);
    if (!pc) {
      devWarn('[Media] attachLocalStream: no PC for peer', peerPubkeyBase64.slice(0, 16));
      return false;
    }
    // 用 addTransceiver({direction:'sendonly'}) 而非 addTrack:
    //   addTrack 會「復用」既有一條 recvonly transceiver — 也就是 Win 之前**當 receiver
    //   收螢幕**留下的死殼。撿去送的話 renegotiation 撞雙方方向衝突 → currentDirection
    //   收斂成 inactive → sender 完全不送 → receiver 黑屏(實測 mid=2 recvonly→inactive,
    //   framesSent 卡 14)。addTransceiver 強制建**新的 sendonly** transceiver,不碰收流死殼。
    //   配合 detachLocalStream 的 transceiver.stop():每個 session 一條乾淨 sendonly,送完 stop,
    //   不疊加、不黑屏;receiver 仍拿到 fresh ontrack(新 m-section)→ viewer 正常重開。
    const senders: RTCRtpSender[] = [];
    for (const track of stream.getTracks()) {
      try {
        const transceiver = pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [stream],  // 讓 receiver ontrack 的 event.streams[0] 有值(webrtc.ts 靠它)
        });
        const sender = transceiver.sender;
        senders.push(sender);
        diagLog('[DIAG:Media] addTransceiver(sendonly)', track.kind, 'to', peerPubkeyBase64.slice(0, 16),
          'streamId:', stream.id.slice(0, 12));
        if (track.kind === 'video') this.applyVideoEncoderParams(sender);
      } catch (err) {
        console.error('[Media] addTransceiver failed:', err);
      }
    }
    if (senders.length > 0) {
      this.localSenders.set(peerPubkeyBase64, senders);
    }
    return senders.length > 0;
  }

  /**
   * 套用螢幕分享 video encoder 參數(2Mbps / 24fps / maintain-resolution)。
   *
   * Phase 2 §6.2:WebRTC 預設 screen-share bitrate 偏低(~500kbps)畫面糊;但 4Mbps + 30fps
   * 在 Tailscale wireguard / 一般家用 wifi 上行頻寬下會塞爆(MTU 1280 + 加密 overhead →
   * packet 切片 → loss → encoder 拼命送 keyframe → 延遲堆積)。2Mbps + 24fps 是 1080p
   * 螢幕分享甜蜜點。degradationPreference=maintain-resolution → loss 高時降 fps 保解析度
   * (螢幕分享要看清字,降 fps 比降解析度好接受)。
   */
  private applyVideoEncoderParams(sender: RTCRtpSender): void {
    void (async () => {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = 2_000_000;
        params.encodings[0].maxFramerate = 24;
        params.degradationPreference = 'maintain-resolution';
        await sender.setParameters(params);
        const echo = sender.getParameters();
        diagLog('[DIAG:Media] video encoding set: maxBitrate=', echo.encodings?.[0]?.maxBitrate,
          'maxFramerate=', echo.encodings?.[0]?.maxFramerate,
          'degradation=', echo.degradationPreference);
      } catch (err) {
        devWarn('[Media] setParameters failed:', (err as Error).message);
      }
    })();
  }

  /**
   * 從指定 peer 拔掉所有本機推送的 tracks。
   *
   * **注意**：removeTrack 後 caller 還必須走 SCREEN_SHARE_END 信令通知對方，
   * 並（可選）createOffer 重新協商。本 method 只負責 track 移除。
   */
  detachLocalStream(peerPubkeyBase64: string): void {
    const pc = webrtcService.getPeerConnection(peerPubkeyBase64);
    const senders = this.localSenders.get(peerPubkeyBase64);
    if (!senders || senders.length === 0) return;
    let stopped = 0;
    if (pc) {
      const transceivers = pc.getTransceivers();
      for (const sender of senders) {
        // transceiver.stop() 取代 removeTrack:**徹底釋放** transceiver(encoder 立即停、
        // m-section 標記 stopped、不再佔 BWE),這樣下次 startSharing 的 addTrack 是唯一
        // active transceiver,不會被舊死殼搶資源 → 修「第二次 session 卡 1-2 fps」。
        // stop() 立即生效(不必等 renegotiation);下次 renegotiateOffer 出來的 SDP 自然帶
        // stopped m-section(port 0),receiver 收到就釋放對應舊 receiver。
        const tx = transceivers.find((t) => t.sender === sender);
        if (tx && typeof tx.stop === 'function' && tx.currentDirection !== 'stopped') {
          try { tx.stop(); stopped++; }
          catch (err) {
            devWarn('[Media] transceiver.stop failed, fallback removeTrack:', (err as Error).message);
            try { pc.removeTrack(sender); } catch { /* ignore */ }
          }
        } else {
          // 找不到 transceiver(理論上不該發生)→ 至少 removeTrack 停送
          try { pc.removeTrack(sender); } catch { /* ignore */ }
        }
      }
    }
    this.localSenders.delete(peerPubkeyBase64);
    diagLog('[DIAG:Media] detached', senders.length, 'sender(s) (stopped', stopped, 'transceivers) from', peerPubkeyBase64.slice(0, 16));
  }

  /**
   * Broadcast helper：對所有已連 peer attach 同一支 stream。
   *
   * 跨裝置螢幕延伸常見情境：使用者在 Mac 上「開始分享」，AegisTrans 把 stream
   * 推給目前線上的所有自己其他裝置。回傳成功 attach 的 peer 數。
   */
  attachLocalStreamToAllPeers(stream: MediaStream, peerPubkeys: string[]): number {
    let count = 0;
    for (const peerPk of peerPubkeys) {
      if (this.attachLocalStream(peerPk, stream)) count++;
    }
    return count;
  }

  detachLocalStreamFromAllPeers(): void {
    const peers = Array.from(this.localSenders.keys());
    for (const peerPk of peers) this.detachLocalStream(peerPk);
  }

  // ============================================
  // Remote stream（ontrack 路徑）
  // ============================================

  /**
   * 註冊「收到遠端 stream」listener。
   * 同 peer 換新 stream 也會 fire（caller 自行用 stream.id 判斷是否新會話）。
   */
  onRemoteStream(callback: RemoteStreamCallback): () => void {
    this.remoteStreamListeners.add(callback);
    return () => this.remoteStreamListeners.delete(callback);
  }

  /**
   * 註冊「遠端 stream 結束」listener（單側 ended event 或 PC 整條關閉時 fire）。
   */
  onRemoteStreamEnded(callback: RemoteStreamEndedCallback): () => void {
    this.remoteStreamEndedListeners.add(callback);
    return () => this.remoteStreamEndedListeners.delete(callback);
  }

  /**
   * 取最後快取的遠端 stream（同步，沒收到過就 null）。
   * 給 React component 在 mount 時補抓最近一次。
   */
  getRemoteStream(peerPubkeyBase64: string): MediaStream | null {
    return this.remoteStreams.get(peerPubkeyBase64) ?? null;
  }

  /**
   * 主動結束 remote stream（給 signaling 層用,例如 SCREEN_SHARE_END 收到時）。
   *
   * WebRTC 在 receiver 端「sender stop track → receiver track 自動 ended」事件
   * 不可靠 — 可能變 muted、不 fire ended,要等 PC 關閉才會掉。所以收到 application-
   * level 結束信令時要主動 fire ended listeners,讓 RemoteScreenViewer 立刻收回 modal。
   */
  forceEndRemoteStream(peerPubkeyBase64: string): void {
    const stream = this.remoteStreams.get(peerPubkeyBase64);
    if (!stream) return;
    this.stopReceiverStatsPolling(peerPubkeyBase64);
    this.remoteStreams.delete(peerPubkeyBase64);
    this.remoteStreamEndedListeners.forEach((cb) => {
      try { cb(peerPubkeyBase64); } catch (err) { console.error('[Media] ended listener threw:', err); }
    });
  }

  // ============================================
  // Internal
  // ============================================

  private handleRemoteStream(peerPubkeyBase64: string, stream: MediaStream): void {
    const prev = this.remoteStreams.get(peerPubkeyBase64);
    // 同一條 stream 重複觸發（多個 track 分批 ontrack）→ 不重發 listener，避免 React 多次 setState
    if (prev && prev.id === stream.id) {
      diagLog('[DIAG:Media] same stream, additional track on', peerPubkeyBase64.slice(0, 16));
      return;
    }
    this.remoteStreams.set(peerPubkeyBase64, stream);
    // 開始 receiver-side stats polling — sender 端有 dumpSenderStats(screenShare.ts),
    // receiver 端必須有對應的 inbound-rtp 觀察點才能定位「sender 送 / receiver 收」斷層
    if (stream.getVideoTracks().length > 0) {
      this.startReceiverStatsPolling(peerPubkeyBase64);
    }
    // 監聽 stream 整條結束（所有 tracks 都 ended）→ 通知 ended listener
    const onTrackEnded = () => {
      if (stream.getTracks().every((t) => t.readyState === 'ended')) {
        this.stopReceiverStatsPolling(peerPubkeyBase64);
        this.remoteStreams.delete(peerPubkeyBase64);
        this.remoteStreamEndedListeners.forEach((cb) => {
          try { cb(peerPubkeyBase64); } catch (err) { console.error('[Media] ended listener threw:', err); }
        });
      }
    };
    stream.getTracks().forEach((t) => t.addEventListener('ended', onTrackEnded));
    // fan out to listeners
    this.remoteStreamListeners.forEach((cb) => {
      try { cb(peerPubkeyBase64, stream); }
      catch (err) { console.error('[Media] remoteStream listener threw:', err); }
    });
  }

  /**
   * Receiver-side inbound-rtp stats polling。每 3s 一次,跟 sender 的
   * dumpSenderStats(screenShare.ts:417 startStatsPolling) 同 cadence,log 對得起來。
   *
   * 量什麼 / 為什麼:
   *   - bytesReceived → 算 inbound bitrate(對比 sender 的 outbound bitrate)
   *   - framesReceived / framesDecoded / framesDropped → decoder 跟得上嗎
   *   - packetsLost / jitter → 網路真的有 loss 嗎(對比 sender 的 retx)
   *
   * 三段 fps 對比(本檔 + screenShare.ts):
   *   source-fps(sender media-source) ≈ encoder-fps(sender outbound-rtp)
   *     ≈ inbound-fps(receiver inbound-rtp framesPerSecond)
   *     ≈ decoded-fps(framesDecoded delta)
   *   任何一段斷層 = 該段就是 bottleneck。
   */
  private startReceiverStatsPolling(peerPubkeyBase64: string): void {
    this.stopReceiverStatsPolling(peerPubkeyBase64);
    this.receiverStatsPrev.delete(peerPubkeyBase64);
    this.receiverStatsPrev.set(peerPubkeyBase64, new Map());
    const peerShort = peerPubkeyBase64.slice(0, 12);
    const interval = setInterval(async () => {
      const pc = webrtcService.getPeerConnection(peerPubkeyBase64);
      if (!pc) {
        this.stopReceiverStatsPolling(peerPubkeyBase64);
        return;
      }
      try {
        const stats = await pc.getStats();
        const inbounds: any[] = [];
        stats.forEach((report: any) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            inbounds.push(report);
          }
        });
        if (inbounds.length === 0) {
          diagLog('[DIAG:RecvStats]', peerShort, 'no-inbound-video');
        } else {
          const perSsrc = this.receiverStatsPrev.get(peerPubkeyBase64) ?? new Map();
          for (const inbound of inbounds) {
            const ssrc = Number(inbound.ssrc ?? 0);
            const prev = perSsrc.get(ssrc);
            let bitrateKbps = 0;
            let recvFpsDelta = 0;
            let decFpsDelta = 0;
            let dropDelta = 0;
            let packetLossDelta = 0;
            if (prev && prev.timestamp > 0) {
              const tDelta = ((inbound.timestamp ?? 0) - prev.timestamp) / 1000;
              if (tDelta > 0) {
                bitrateKbps = Math.round(((inbound.bytesReceived ?? 0) - prev.bytesReceived) * 8 / 1000 / tDelta);
                recvFpsDelta = Math.round(((inbound.framesReceived ?? 0) - prev.framesReceived) / tDelta);
                decFpsDelta = Math.round(((inbound.framesDecoded ?? 0) - prev.framesDecoded) / tDelta);
                dropDelta = (inbound.framesDropped ?? 0) - prev.framesDropped;
                packetLossDelta = (inbound.packetsLost ?? 0) - prev.packetsLost;
              }
            }
            perSsrc.set(ssrc, {
              bytesReceived: inbound.bytesReceived ?? 0,
              framesDecoded: inbound.framesDecoded ?? 0,
              framesDropped: inbound.framesDropped ?? 0,
              packetsLost: inbound.packetsLost ?? 0,
              framesReceived: inbound.framesReceived ?? 0,
              timestamp: inbound.timestamp ?? 0,
            });
            diagLog('[DIAG:RecvStats]', peerShort,
              'ssrc=' + ssrc,
              'rid=' + (inbound.rid ?? '-'),
              'inbound-bitrate=' + bitrateKbps + 'kbps',
              'recv-fps=' + recvFpsDelta,
              'dec-fps=' + decFpsDelta,
              'inbound-fps=' + (inbound.framesPerSecond ?? '?'),
              'framesReceived=' + (inbound.framesReceived ?? '?'),
              'framesDecoded=' + (inbound.framesDecoded ?? '?'),
              'dropped(Δ)=' + dropDelta,
              'pktLoss(Δ)=' + packetLossDelta,
              'jitter=' + (inbound.jitter ?? '?') + 's',
              'res=' + (inbound.frameWidth ?? '?') + 'x' + (inbound.frameHeight ?? '?'),
              'keyDec=' + (inbound.keyFramesDecoded ?? '?'),
              'decoder=' + (inbound.decoderImplementation ?? '?'),
            );
          }
          this.receiverStatsPrev.set(peerPubkeyBase64, perSsrc);
        }
        // Receiver-side track state — 看 receiver 端 track.muted 是否被 sender 觸發
        // muted event(WebRTC spec 規定 sender 不送的時候 receiver track 進 muted)
        try {
          const receivers = pc.getReceivers();
          for (const r of receivers) {
            const t = r.track;
            if (!t || t.kind !== 'video') continue;
            diagLog('[DIAG:RecvTrack]', peerShort,
              'id=' + (t.id?.slice(0, 8) ?? '?'),
              'readyState=' + t.readyState,
              'muted=' + t.muted,
              'enabled=' + t.enabled,
            );
          }
        } catch (err) {
          devWarn('[Media] recv track dump failed:', (err as Error).message);
        }
      } catch (err) {
        devWarn('[Media] receiver stats poll failed:', (err as Error).message);
      }
    }, 3000);
    this.receiverStatsIntervals.set(peerPubkeyBase64, interval);
    diagLog('[DIAG:RecvStats] receiver-side stats polling started for', peerShort);
  }

  private stopReceiverStatsPolling(peerPubkeyBase64: string): void {
    const interval = this.receiverStatsIntervals.get(peerPubkeyBase64);
    if (interval) {
      clearInterval(interval);
      this.receiverStatsIntervals.delete(peerPubkeyBase64);
      this.receiverStatsPrev.delete(peerPubkeyBase64);
      diagLog('[DIAG:RecvStats] receiver-side stats polling stopped for', peerPubkeyBase64.slice(0, 12));
    }
  }
}

export const mediaChannelService = new MediaChannelService();
export default mediaChannelService;
