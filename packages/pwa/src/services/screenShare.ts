/**
 * Screen Share Service — 1:1 跨裝置螢幕分享 sender + 信令處理（Phase 2 §6.4-6.6）
 *
 * 職責：
 *   - sender 端流程：attachLocalStream → SDP renegotiation → 等對方 accept / reject
 *   - 接收 SCREEN_SHARE_OFFER → 暫存 pending offer（不自動 setRemoteDescription，等使用者 accept）
 *   - acceptIncoming() → setRemoteDescription + createAnswer + 送 SCREEN_SHARE_ANSWER
 *   - rejectIncoming() → 送 SCREEN_SHARE_REJECT，sender 端收到 → detachLocalStream
 *   - 結束時送 SCREEN_SHARE_END
 *
 * 不做：
 *   - getDisplayMedia 呼叫（那是 plugin 層，由 caller 透過 AegisDisplay.captureScreen 傳入 stream）
 *   - track / stream 物件管理（mediaChannel.ts）
 *   - PeerConnection 建立（webrtc.ts；本服務假設 PC 已連）
 *
 * 限制（Phase 2 v1）：
 *   - 1:1（sender 一次推給一台 receiver；caller 想推多台要重複呼叫 startSharing）
 *   - 沒 reconnect 邏輯：peer 中途離線，stream 自動因 PC 斷而失效
 *   - 單向：receiver 不反向控制 sender（v2 才加）
 *   - 平台限制由 plugin 層偵測（手機不支援 source）
 */

import { mqttService, MessageType, type MqttMessage } from './mqtt';
import { webrtcService } from './webrtc';
import { mediaChannelService } from './mediaChannel';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';

/**
 * transport 分流：
 *   'renegotiate' — 桌面 sender：在既有 file PC 上加 video track 重新協商(原始路徑,
 *                   ICE 已連,不需 SCREEN_SHARE_ICE)。省略時預設此值(向後相容)。
 *   'dedicated'   — 行動端原生 sender(iOS Broadcast Extension / Android MediaProjection)：
 *                   螢幕 video 在獨立 native PC 上 → 接收端要建專用 PC + 全新 trickle ICE。
 */
type ScreenTransport = 'renegotiate' | 'dedicated';

interface ScreenShareSdpPayload {
  sdp: string;
  type: 'offer' | 'answer';
  transport?: ScreenTransport;
}

/** 接收端尚未 accept 的進來 offer。等使用者點 accept 才 setRemoteDescription。 */
export interface PendingIncomingOffer {
  peerPubkeyBase64: string;
  sdp: string;
  receivedAt: number;
  transport: ScreenTransport;
}

type ShareStateCallback = (sharing: boolean, peerPubkey: string | null) => void;
type IncomingOfferCallback = (offer: PendingIncomingOffer | null) => void;
type PeerRejectedCallback = (peerPubkey: string) => void;

class ScreenShareService {
  // sender 狀態
  private localStream: MediaStream | null = null;
  private sharedToPeer: string | null = null;  // 1:1 — 同時只有一個目標
  // receiver 狀態：暫存 pending offer，等 user accept
  private pendingIncoming: PendingIncomingOffer | null = null;
  // sender-side stats polling
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  /** per-SSRC delta state(simulcast/SVC 多 layer 各自算 bitrate) */
  private statsPerSsrc: Map<number, { bytesSent: number; timestamp: number }> = new Map();

  private mqttUnsubs: Array<() => void> = [];
  private stateListeners: Set<ShareStateCallback> = new Set();
  private incomingOfferListeners: Set<IncomingOfferCallback> = new Set();
  private peerRejectedListeners: Set<PeerRejectedCallback> = new Set();
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.mqttUnsubs.push(
      mqttService.onMessage(MessageType.SCREEN_SHARE_OFFER, (msg) => this.handleIncomingOffer(msg)),
      mqttService.onMessage(MessageType.SCREEN_SHARE_ANSWER, (msg) => { void this.handleIncomingAnswer(msg); }),
      mqttService.onMessage(MessageType.SCREEN_SHARE_END, (msg) => this.handleIncomingEnd(msg)),
      mqttService.onMessage(MessageType.SCREEN_SHARE_REJECT, (msg) => this.handleIncomingReject(msg)),
    );
    this.initialized = true;
    diagLog('[DIAG:Screen] service initialized');
  }

  shutdown(): void {
    this.mqttUnsubs.forEach((u) => u());
    this.mqttUnsubs = [];
    void this.stopSharing();
    this.pendingIncoming = null;
    this.notifyIncoming(null);
    this.stateListeners.clear();
    this.incomingOfferListeners.clear();
    this.peerRejectedListeners.clear();
    this.initialized = false;
  }

  // ============================================
  // Sender API（1:1）
  // ============================================

  isSharing(): boolean {
    return !!this.localStream;
  }

  getCurrentPeer(): string | null {
    return this.sharedToPeer;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  onShareStateChange(callback: ShareStateCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /** sender：對方拒絕了你發起的分享 → 用此 callback 顯示 UI 提示 */
  onPeerRejected(callback: PeerRejectedCallback): () => void {
    this.peerRejectedListeners.add(callback);
    return () => this.peerRejectedListeners.delete(callback);
  }

  /**
   * 開始對指定 peer 分享 stream（1:1）。
   *
   * 流程：
   *   1. 確認 peer 有 PC（webrtc.getPeerConnection）
   *   2. mediaChannel.attachLocalStream(peer, stream) → addTrack
   *   3. createOffer → setLocalDescription
   *   4. 送 SCREEN_SHARE_OFFER 給 peer
   *   5. 等 peer 端 SCREEN_SHARE_ANSWER（由 handleIncomingAnswer 處理）
   *      或 SCREEN_SHARE_REJECT（由 handleIncomingReject 處理）
   *
   * 同時只能對一台 peer 分享；已在分享 → throw。
   */
  async startSharing(stream: MediaStream, peerPubkeyBase64: string): Promise<void> {
    if (this.localStream) {
      throw new Error('Already sharing — stop first');
    }
    const pc = webrtcService.getPeerConnection(peerPubkeyBase64);
    if (!pc) {
      throw new Error('No P2P connection to peer; please retry after connecting');
    }

    this.localStream = stream;
    this.sharedToPeer = peerPubkeyBase64;

    // user 點瀏覽器 / OS 通知列「停止分享」會 fire ended → 自動 stop
    stream.getTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        diagLog('[DIAG:Screen] local track ended (user stopped via browser UI)');
        void this.stopSharing();
      });
    });

    try {
      const attached = mediaChannelService.attachLocalStream(peerPubkeyBase64, stream);
      if (!attached) throw new Error('attachLocalStream returned false');
      await this.renegotiateOffer(peerPubkeyBase64);
      this.notifyState();
      this.startStatsPolling(peerPubkeyBase64);
      devLog('[Screen] sharing started to', peerPubkeyBase64.slice(0, 16));
    } catch (err) {
      // rollback — 失敗就清狀態
      this.localStream = null;
      this.sharedToPeer = null;
      mediaChannelService.detachLocalStream(peerPubkeyBase64);
      stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      this.notifyState();
      throw err;
    }
  }

  async stopSharing(): Promise<void> {
    if (!this.localStream || !this.sharedToPeer) return;
    const stream = this.localStream;
    const peer = this.sharedToPeer;
    this.localStream = null;
    this.sharedToPeer = null;
    this.stopStatsPolling();

    // 通知對方先（信令早於 SRTP 斷線 → receiver UI 立刻掉 modal）
    try {
      mqttService.sendToUser(peer, MessageType.SCREEN_SHARE_END, {});
    } catch (err) {
      devWarn('[Screen] sendEnd failed:', (err as Error).message);
    }
    mediaChannelService.detachLocalStream(peer);
    stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });

    // 如果 ANSWER 還沒回來就 stop(use case:user 等不及 / 對方 reject) → PC 卡
    // have-local-offer,下一次 acceptIncoming / startSharing 會撞 "PC not stable"。
    // 主動 rollback 把 localDescription 清掉,讓 PC 回 stable state。
    const pc = webrtcService.getPeerConnection(peer);
    if (pc && pc.signalingState === 'have-local-offer') {
      try {
        await pc.setLocalDescription({ type: 'rollback' });
        diagLog('[DIAG:Screen] stopSharing: rolled back pending local offer');
      } catch (err) {
        devWarn('[Screen] stopSharing rollback failed:', (err as Error).message);
      }
    }

    this.notifyState();
    diagLog('[DIAG:Screen] stopSharing complete — peer:', peer.slice(0, 16));
  }

  // ============================================
  // Receiver API
  // ============================================

  /** 訂閱「有 incoming offer 等接受 / 拒絕」狀態。null = 沒 pending。 */
  onIncomingOffer(callback: IncomingOfferCallback): () => void {
    this.incomingOfferListeners.add(callback);
    // 立即發一次目前狀態
    callback(this.pendingIncoming);
    return () => this.incomingOfferListeners.delete(callback);
  }

  getPendingIncoming(): PendingIncomingOffer | null {
    return this.pendingIncoming;
  }

  /**
   * 接受 incoming offer → setRemoteDescription + createAnswer + 送 SCREEN_SHARE_ANSWER。
   * 接受後 mediaChannel.onRemoteStream listener 會 fire（peer track 已透過 ontrack 進來）。
   */
  async acceptIncoming(): Promise<void> {
    const offer = this.pendingIncoming;
    if (!offer) return;
    this.pendingIncoming = null;
    this.notifyIncoming(null);

    // dedicated 路徑(行動端原生 sender)：建獨立接收 PC + 全新 trickle ICE,不碰 file PC。
    if (offer.transport === 'dedicated') {
      await this.acceptDedicated(offer);
      return;
    }

    const pc = webrtcService.getPeerConnection(offer.peerPubkeyBase64);
    if (!pc) {
      console.error('[Screen] acceptIncoming: no PC for', offer.peerPubkeyBase64.slice(0, 16));
      return;
    }
    // 二次投放卡關常見原因:PC 還在 have-local-offer state(上一輪 startSharing 沒收到
    // ANSWER 就 stop,localDescription 沒清乾淨)。Perfect negotiation pattern:
    // 如果 incoming offer 跟本機 pending outgoing offer 衝突,本機 rollback 讓步,
    // 再接 incoming offer。
    if (pc.signalingState === 'have-local-offer') {
      try {
        await pc.setLocalDescription({ type: 'rollback' });
        diagLog('[DIAG:Screen] acceptIncoming: rolled back stale local offer, retrying');
      } catch (err) {
        console.error('[Screen] acceptIncoming: rollback failed:', err);
        return;
      }
    }
    if (pc.signalingState !== 'stable') {
      console.error('[Screen] acceptIncoming: PC still not stable after rollback (got', pc.signalingState, ') — abort');
      return;
    }
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!answer.sdp) throw new Error('createAnswer returned empty SDP');
      mqttService.sendToUser(offer.peerPubkeyBase64, MessageType.SCREEN_SHARE_ANSWER, {
        sdp: answer.sdp,
        type: 'answer',
      } satisfies ScreenShareSdpPayload);
      diagLog('[DIAG:Screen] sent SCREEN_SHARE_ANSWER (accept) to', offer.peerPubkeyBase64.slice(0, 16));
    } catch (err) {
      console.error('[Screen] acceptIncoming failed:', err);
    }
  }

  /**
   * 接受 dedicated 路徑的 offer(行動端原生 sender)：建獨立接收 PC,setRemoteDescription
   * → createAnswer → 送回(transport:'dedicated')。ICE 由 webrtc.ts 的 dedicated PC
   * onicecandidate 自動 trickle SCREEN_SHARE_ICE,並由 handleScreenShareIce 套用 remote ICE。
   * 不碰 file PC,沒有 rollback/glare 那套(全新端點)。
   */
  private async acceptDedicated(offer: PendingIncomingOffer): Promise<void> {
    try {
      diagLog('[NSDIAG-RX] acceptDedicated: creating screen recv PC for', offer.peerPubkeyBase64.slice(0, 12));
      const pc = webrtcService.createScreenReceivePeer(offer.peerPubkeyBase64);
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!answer.sdp) throw new Error('createAnswer returned empty SDP');
      mqttService.sendToUser(offer.peerPubkeyBase64, MessageType.SCREEN_SHARE_ANSWER, {
        sdp: answer.sdp,
        type: 'answer',
        transport: 'dedicated',
      } satisfies ScreenShareSdpPayload);
      diagLog('[NSDIAG-RX] sent dedicated SCREEN_SHARE_ANSWER to', offer.peerPubkeyBase64.slice(0, 12), 'sdp', answer.sdp.length);
    } catch (err) {
      console.error('[Screen] acceptDedicated failed:', err);
      webrtcService.closeScreenReceivePeer(offer.peerPubkeyBase64);
    }
  }

  /**
   * 拒絕 incoming offer → 送 SCREEN_SHARE_REJECT 給 sender。不 setRemoteDescription。
   */
  rejectIncoming(): void {
    const offer = this.pendingIncoming;
    if (!offer) return;
    this.pendingIncoming = null;
    this.notifyIncoming(null);

    try {
      mqttService.sendToUser(offer.peerPubkeyBase64, MessageType.SCREEN_SHARE_REJECT, {});
      diagLog('[DIAG:Screen] sent SCREEN_SHARE_REJECT to', offer.peerPubkeyBase64.slice(0, 16));
    } catch (err) {
      devWarn('[Screen] sendReject failed:', (err as Error).message);
    }
  }

  // ============================================
  // Internal — SDP renegotiation
  // ============================================

  private async renegotiateOffer(peerPubkey: string): Promise<void> {
    const pc = webrtcService.getPeerConnection(peerPubkey);
    if (!pc) throw new Error('no PC for ' + peerPubkey.slice(0, 16));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!offer.sdp) throw new Error('createOffer returned empty SDP');
    mqttService.sendToUser(peerPubkey, MessageType.SCREEN_SHARE_OFFER, {
      sdp: offer.sdp,
      type: 'offer',
      transport: 'renegotiate',
    } satisfies ScreenShareSdpPayload);
    diagLog('[DIAG:Screen] sent SCREEN_SHARE_OFFER to', peerPubkey.slice(0, 16));
  }

  private handleIncomingOffer(msg: MqttMessage): void {
    const payload = msg.payload as ScreenShareSdpPayload;
    const peerPk = msg.from;
    if (!payload || payload.type !== 'offer' || !payload.sdp) {
      devWarn('[Screen] malformed SCREEN_SHARE_OFFER from', peerPk.slice(0, 16));
      return;
    }
    const transport: ScreenTransport = payload.transport === 'dedicated' ? 'dedicated' : 'renegotiate';
    diagLog('[NSDIAG-RX] received SCREEN_SHARE_OFFER from', peerPk.slice(0, 12), 'transport:', transport);
    this.pendingIncoming = {
      peerPubkeyBase64: peerPk,
      sdp: payload.sdp,
      receivedAt: Date.now(),
      transport,
    };
    this.notifyIncoming(this.pendingIncoming);
  }

  private async handleIncomingAnswer(msg: MqttMessage): Promise<void> {
    try {
      const payload = msg.payload as ScreenShareSdpPayload;
      const peerPk = msg.from;
      if (!payload || payload.type !== 'answer' || !payload.sdp) return;

      // Guard 1:沒對這個 peer 發過 SCREEN_SHARE_OFFER → ignore stale answer
      // (避免撞既有 file DataChannel 的 PC SDP state — 從 prev test session 留下的
      // MQTT message 可能在新 session 被收到)
      if (this.sharedToPeer !== peerPk) {
        diagLog('[DIAG:Screen] ignoring SCREEN_SHARE_ANSWER from non-target peer:', peerPk.slice(0, 16));
        return;
      }
      const pc = webrtcService.getPeerConnection(peerPk);
      if (!pc) return;

      // Guard 2:PC 必須在 have-local-offer state setRemoteDescription answer 才合法。
      // stable / have-remote-offer 等 state 呼叫 setRemoteDescription answer 會 throw
      // InvalidStateError,且可能 corrupt 既有 file DataChannel 的 SDP 狀態。
      if (pc.signalingState !== 'have-local-offer') {
        diagLog('[DIAG:Screen] ignoring SCREEN_SHARE_ANSWER — PC signalingState:', pc.signalingState);
        return;
      }
      diagLog('[DIAG:Screen] received SCREEN_SHARE_ANSWER from', peerPk.slice(0, 16));
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    } catch (err) {
      console.error('[Screen] handleIncomingAnswer failed:', err);
    }
  }

  private handleIncomingEnd(msg: MqttMessage): void {
    const peerPk = msg.from;
    diagLog('[DIAG:Screen] received SCREEN_SHARE_END from', peerPk.slice(0, 16));
    // 兩個方向都要處理:
    //   (a) sender 收到 END:對方是 receiver 主動關閉,要停我們的 outgoing share + 通知 UI
    //       讓 DeviceListSidebar 的「停投放」按鈕回 idle。
    //   (b) receiver 收到 END:對方是 sender 主動關掉。WebRTC 的 receiver-track-ended
    //       事件不可靠(sender stop 後 receiver track 可能變 muted 不 fire ended),
    //       所以這裡要主動 fire mediaChannel ended listeners,讓 RemoteScreenViewer
    //       立刻收回 viewer modal。
    if (this.sharedToPeer === peerPk && this.localStream) {
      // (a) sender path
      const stream = this.localStream;
      this.localStream = null;
      this.sharedToPeer = null;
      this.stopStatsPolling();
      mediaChannelService.detachLocalStream(peerPk);
      stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      this.notifyState();
      diagLog('[DIAG:Screen] sender-side stop via receiver END complete — peer:', peerPk.slice(0, 16));
    } else {
      // (b) receiver path — force-fire ended even if track 'ended' event hasn't arrived
      mediaChannelService.forceEndRemoteStream(peerPk);
      // dedicated 路徑：關掉專用接收 PC(若有)。renegotiate 路徑沒有 dedicated PC,no-op。
      webrtcService.closeScreenReceivePeer(peerPk);
    }
  }

  /**
   * Receiver-side:收下 sender 的 stream 看完了主動結束,送 SCREEN_SHARE_END 給 sender,
   * sender 端 handleIncomingEnd 會清狀態 + 通知 UI。
   *
   * 本機端:不在 viewer 裡 stop track(那是 mediaChannel.onRemoteStreamEnded 在管),
   * 這 method 只是 outgoing 信令。UI 自己 setActive(null) 收回 viewer。
   */
  endReceiving(peerPubkeyBase64: string): void {
    try {
      mqttService.sendToUser(peerPubkeyBase64, MessageType.SCREEN_SHARE_END, {});
      diagLog('[DIAG:Screen] receiver sent SCREEN_SHARE_END to', peerPubkeyBase64.slice(0, 16));
    } catch (err) {
      devWarn('[Screen] receiver endReceiving sendEnd failed:', (err as Error).message);
    }
    // dedicated 路徑：本機是接收端,主動關閉時也關掉專用 PC。renegotiate 路徑 no-op。
    webrtcService.closeScreenReceivePeer(peerPubkeyBase64);
  }

  private handleIncomingReject(msg: MqttMessage): void {
    const peerPk = msg.from;
    diagLog('[DIAG:Screen] received SCREEN_SHARE_REJECT from', peerPk.slice(0, 16));
    // sender 端：對方拒絕了 → 清掉本機 stream + 通知 UI
    if (this.sharedToPeer === peerPk && this.localStream) {
      const stream = this.localStream;
      this.localStream = null;
      this.sharedToPeer = null;
      this.stopStatsPolling();
      mediaChannelService.detachLocalStream(peerPk);
      stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
      this.notifyState();
      this.peerRejectedListeners.forEach((cb) => {
        try { cb(peerPk); } catch (err) { console.error('[Screen] rejected listener threw:', err); }
      });
    }
  }

  // ============================================
  // Internal — stats polling (sender-side diagnostics)
  // ============================================

  /**
   * Sender-side getStats 3s polling — log selected candidate pair + video outbound RTP。
   *
   * 目的:診斷「畫面有但延遲很大、刷新很慢」的真因。可能原因:
   *   - ICE pair selected = srflx-srflx (走 Tailscale srflx wireguard 加密 + MTU 1280 + 額外 hop)
   *     而非 host-host (LAN 直連) → 延遲倍增
   *   - encoder 因 qualityLimitationReason='bandwidth' 持續降 fps/解析度
   *   - 真實 bytesSent 遠低於 maxBitrate → 上行頻寬限制
   *   - packetsLost 高 → MTU fragmentation 或 wifi 干擾
   *
   * 不長期跑(stopSharing 時 clear),只在分享期間每 3s 一次,刷 console 不會太密。
   */
  private startStatsPolling(peerPubkey: string): void {
    this.stopStatsPolling();
    this.statsPerSsrc.clear();
    this.statsInterval = setInterval(() => {
      const pc = webrtcService.getPeerConnection(peerPubkey);
      if (!pc) {
        this.stopStatsPolling();
        return;
      }
      void this.dumpSenderStats(pc, peerPubkey);
    }, 3000);
    diagLog('[DIAG:Stats] sender-side stats polling started for', peerPubkey.slice(0, 16));
  }

  private stopStatsPolling(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
      diagLog('[DIAG:Stats] sender-side stats polling stopped');
    }
  }

  private async dumpSenderStats(pc: RTCPeerConnection, peerPubkey: string): Promise<void> {
    try {
      const stats = await pc.getStats();
      let selectedPair: any = null;
      let localCand: any = null;
      let remoteCand: any = null;
      const outboundVideos: any[] = [];
      let mediaSource: any = null;

      // 1) 找 selected/nominated candidate-pair
      stats.forEach((report: any) => {
        if (report.type === 'candidate-pair' &&
            (report.nominated === true || report.selected === true) &&
            report.state === 'succeeded') {
          selectedPair = report;
        }
      });
      // 2) 從 selected pair 找 local/remote candidate detail
      if (selectedPair) {
        stats.forEach((report: any) => {
          if (report.id === selectedPair.localCandidateId) localCand = report;
          if (report.id === selectedPair.remoteCandidateId) remoteCand = report;
        });
      }
      // 3) 收集 **所有** outbound-rtp video(simulcast/SVC 多 SSRC + 跨 renegotiation
      //    殘留 SSRC,不能 `last wins`,會抓到死的那條誤判 encoder freeze)
      stats.forEach((report: any) => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          outboundVideos.push(report);
        }
        if (report.type === 'media-source' && report.kind === 'video') {
          mediaSource = report;
        }
      });

      const peerShort = peerPubkey.slice(0, 12);
      const pairLine = selectedPair && localCand && remoteCand
        ? `${localCand.candidateType}:${localCand.address || localCand.ip}:${localCand.port}/${localCand.protocol} → ${remoteCand.candidateType}:${remoteCand.address || remoteCand.ip}:${remoteCand.port} rtt=${selectedPair.currentRoundTripTime ?? '?'}s`
        : 'no-selected-pair-yet';
      const sourceLine = mediaSource
        ? `source-fps=${mediaSource.framesPerSecond ?? '?'} source-res=${mediaSource.width ?? '?'}x${mediaSource.height ?? '?'} source-frames=${mediaSource.frames ?? '?'}`
        : 'no-media-source';

      // Per-SSRC bitrate + log 每條 layer。WebRTC 在 simulcast 模式下會給 3 條 outbound-rtp
      // (high/mid/low),每條獨立 SSRC + active flag。Last-wins 抓 code 可能抓到死的那條
      // 結果誤判 encoder freeze;這裡列全部,讓我們看清楚哪條真的在動。
      if (outboundVideos.length === 0) {
        diagLog('[DIAG:Stats]', peerShort, 'pair:', pairLine, '| src:', sourceLine, '| enc: no-outbound-video');
      } else {
        for (const ov of outboundVideos) {
          const ssrc = Number(ov.ssrc ?? 0);
          let bitrateKbps = 0;
          const prev = this.statsPerSsrc.get(ssrc);
          if (prev && prev.timestamp > 0) {
            const bytesDelta = (ov.bytesSent ?? 0) - prev.bytesSent;
            const timeDelta = ((ov.timestamp ?? 0) - prev.timestamp) / 1000;
            if (timeDelta > 0) {
              bitrateKbps = Math.round((bytesDelta * 8) / 1000 / timeDelta);
            }
          }
          this.statsPerSsrc.set(ssrc, {
            bytesSent: ov.bytesSent ?? 0,
            timestamp: ov.timestamp ?? 0,
          });
          // active(spec): false 代表 sender.setParameters({encodings:[{active:false}]})
          // 顯式關掉的 layer — encoder 不會送任何 frame。也可能是 simulcast 動態降層。
          const encLine = `ssrc=${ssrc} rid=${ov.rid ?? '-'} active=${ov.active ?? '?'} enc-bitrate=${bitrateKbps}kbps enc-fps=${ov.framesPerSecond ?? '?'} enc-res=${ov.frameWidth ?? '?'}x${ov.frameHeight ?? '?'} framesSent=${ov.framesSent ?? '?'} packetsSent=${ov.packetsSent ?? '?'} bytesSent=${ov.bytesSent ?? '?'} qLimit=${ov.qualityLimitationReason ?? '?'} keyEnc=${ov.keyFramesEncoded ?? '?'} retx=${ov.retransmittedPacketsSent ?? 0} encoder=${ov.encoderImplementation ?? '?'}`;
          diagLog('[DIAG:Stats]', peerShort, 'pair:', pairLine, '| src:', sourceLine, '| enc:', encLine);
        }
      }

      // PC topology dump — 驗「transceiver 疊加」bug + 修復效果。
      // 第二次 session 如果還是 2 條 video transceiver(一條 track=null 的死殼)→ 修復沒生效;
      // 修對的話永遠只有 1 條 video transceiver。
      try {
        const transceivers = pc.getTransceivers();
        const txInfo = transceivers
          .map((t) => `${t.mid ?? '?'}:${t.currentDirection ?? t.direction ?? '?'}:${t.sender.track?.kind ?? 'null'}`)
          .join(',');
        // 修復成功的判準:不管第幾次 session,**active(非 stopped)的 video send transceiver 永遠 = 1**。
        // 舊 bug 會看到 active-video-send-tx=2(一條死殼還活著搶資源)。
        const activeVideoSendTx = transceivers.filter(
          (t) => t.currentDirection !== 'stopped' && t.sender.track?.kind === 'video'
        ).length;
        diagLog('[DIAG:PC]', peerShort,
          'transceivers=' + transceivers.length,
          'active-video-send-tx=' + activeVideoSendTx,
          'senders=' + pc.getSenders().length,
          '[' + txInfo + ']');
      } catch (err) {
        devWarn('[Screen] PC topology dump failed:', (err as Error).message);
      }

      // Track state dump — 驗 H3 假設「track 進到 muted / ended 狀態」
      // (Chromium 在 virtual display 某些情況下 track.muted=true → encoder pause)
      // 同時 dump sender.getParameters() encodings,確認 setParameters 後實際 encoder 設定
      try {
        const senders = pc.getSenders();
        for (const s of senders) {
          const t = s.track;
          if (!t || t.kind !== 'video') continue;
          const settings: any = (() => {
            try { return t.getSettings(); } catch { return {}; }
          })();
          let encodingsLine = '?';
          try {
            const params = s.getParameters();
            encodingsLine = JSON.stringify(params.encodings ?? []);
          } catch (err) {
            encodingsLine = `getParameters-failed: ${(err as Error).message}`;
          }
          diagLog('[DIAG:Track]', peerShort,
            'kind=' + t.kind,
            'id=' + (t.id?.slice(0, 8) ?? '?'),
            'readyState=' + t.readyState,
            'muted=' + t.muted,
            'enabled=' + t.enabled,
            'contentHint=' + ((t as any).contentHint ?? '?'),
            'settings.fps=' + (settings.frameRate ?? '?'),
            'settings.res=' + (settings.width ?? '?') + 'x' + (settings.height ?? '?'),
            'settings.deviceId=' + ((settings.deviceId ?? '').toString().slice(0, 16) || '-'),
            'encodings=' + encodingsLine,
          );
        }
      } catch (err) {
        devWarn('[Screen] track-state dump failed:', (err as Error).message);
      }
    } catch (err) {
      devWarn('[Screen] dumpSenderStats failed:', (err as Error).message);
    }
  }

  // ============================================
  // Internal — listener fan-out
  // ============================================

  private notifyState(): void {
    const sharing = !!this.localStream;
    const peer = this.sharedToPeer;
    this.stateListeners.forEach((cb) => {
      try { cb(sharing, peer); } catch (err) { console.error('[Screen] state listener threw:', err); }
    });
  }

  private notifyIncoming(offer: PendingIncomingOffer | null): void {
    this.incomingOfferListeners.forEach((cb) => {
      try { cb(offer); } catch (err) { console.error('[Screen] incoming listener threw:', err); }
    });
  }
}

export const screenShareService = new ScreenShareService();
export default screenShareService;
