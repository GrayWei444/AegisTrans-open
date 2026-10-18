/**
 * WebRTC Service - P2P 連線管理
 *
 * 透過 WebRTC 建立端對端加密的 P2P 連線
 * 使用 MQTT 作為信令通道
 */

import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { mqttService, MessageType, type MqttMessage } from './mqtt';
import { getIceServers } from './iceServers';
import { DEBUG_TOOLS } from '../utils/debugFlags';
import { splitFrame, FrameAssembler, utf8Length } from './dcFraming';

// IPv6 優先設定
const IPV6_FIRST_ENABLED = true;

// ICE 連線類型（用於監控）
export enum IceCandidateType {
  HOST = 'host',       // 直連（IPv4/IPv6）
  SRFLX = 'srflx',     // STUN 反射
  PRFLX = 'prflx',     // Peer 反射
  RELAY = 'relay',     // TURN 中繼
}

// 連線狀態
export enum PeerConnectionState {
  NEW = 'new',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  FAILED = 'failed',
  CLOSED = 'closed',
}

// 資料通道狀態
export enum DataChannelState {
  CONNECTING = 'connecting',
  OPEN = 'open',
  CLOSING = 'closing',
  CLOSED = 'closed',
}

// Peer 連線資訊
export interface PeerInfo {
  publicKeyBase64: string;
  connection: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  connectionState: PeerConnectionState;
  dataChannelState: DataChannelState;
  isInitiator: boolean;
  // IPv6 優先：暫存「出去的」candidates 以便排序
  pendingCandidates: RTCIceCandidate[];
  candidateFlushTimer: NodeJS.Timeout | null;
  // 「進來的」ICE candidate 若 remoteDescription 還沒 set,先存這裡,
  // setRemoteDescription(offer/answer) 後再 flush。修 trickle-ICE race:
  // candidate 早於 offer/answer 經 MQTT 到達 → addIceCandidate throw
  // 「remote description was null」→ 被丟 → ICE 缺候選永遠卡 checking。
  incomingCandidates: RTCIceCandidateInit[];
  /** 超過 DataChannel 上限的訊息會分塊送（dcFraming，傳輸統一 X5）；這裡重組對方送來的片段 */
  rxFrames?: FrameAssembler;
}

// 訊息回調
type MessageCallback = (peerPublicKey: string, data: ArrayBuffer | string) => void;
type StateCallback = (peerPublicKey: string, state: PeerConnectionState) => void;
type DataChannelStateCallback = (peerPublicKey: string, state: DataChannelState) => void;
// Phase 2：遠端 MediaStream 事件（addTrack 後的 ontrack 觸發）
// 給 mediaChannel.ts 接收 — webrtc.ts 不解析 stream 內容，只負責橋接
type MediaStreamCallback = (peerPublicKey: string, stream: MediaStream) => void;

/**
 * WebRTC P2P 連線服務
 */
class WebRTCService {
  private peers: Map<string, PeerInfo> = new Map();
  private localPublicKeyBase64: string | null = null;
  // Perfect Negotiation：正在送 offer 的 peer（判 offer collision 用，glare 不再靠 closePeer 拆連線）
  private makingOffer: Set<string> = new Set();

  // 本輪連線嘗試的起算時間（port AegisTalk）：DataChannel 一直沒 open、PC 卡在
  //   new/connecting/checking 超過 STUCK_REBUILD_MS → 視為死、砍掉重建 fresh。
  //   只殺「從未 open 的卡死握手」（活/已 open 的在 connect() 上方早就 return）→ 不週期性拆活連線。
  private connectAttemptAt: Map<string, number> = new Map();
  private static readonly STUCK_REBUILD_MS = 25_000;

  // 🔑 殭屍 DataChannel 偵測（2026-07-14，broker trace 實證）：DC readyState 可能永遠停在
  //   'open'、PC 也停在 'connected'，但底層傳輸早已死（iOS App 被凍結過後最常見）。此時
  //   send() 不 throw、訊息直接蒸發，而三層健康檢查（connect() 早退 / isPeerHealthy /
  //   peerHealthMonitor）全都只看 readyState → 全自認健康 → 永不自救，要重開 App 才好。
  //   對策：DC 上跑心跳。**收到任何** DC 資料（含心跳）就記時；太久沒收到 = 通道死了。
  //   相容性：只有「確認會送心跳」的對端才套用新判定，舊版對端維持原本 readyState 判斷，
  //   否則舊版永遠被判死 → 無限重建。
  private lastDcInboundAt: Map<string, number> = new Map();
  private hbCapablePeers: Set<string> = new Set();
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly DC_HEARTBEAT_MS = 10_000;
  private static readonly DC_STALE_MS = 35_000;  // 連漏 3 拍才判死
  private static readonly DC_HEARTBEAT_FRAME = '{"type":"__dc_hb"}';

  // ── 大訊息分塊（傳輸統一 X5）──
  /** 分塊時每片上限：取對端宣告的 SCTP max-message-size（未宣告時 RFC 預設 64KB），最多 240KB 留餘裕 */
  private static frameLimitFor(peer: PeerInfo): number {
    const advertised = peer.connection.sctp?.maxMessageSize;
    const max = typeof advertised === 'number' && advertised > 0 ? advertised : 65_536;
    return Math.max(16 * 1024, Math.min(240 * 1024, max - 1024));
  }
  /**
   * 不分塊的上限＝舊版直接 send() 送得出去的大小：對端宣告的上限，拿不到 sctp 時（null／undefined，
   * 例如 ICE 短暫斷線）用 Chromium 的 256KB。舊版收端不認得分塊幀，這個範圍內一律單幀送，
   * 新舊版混用時以前收得到的訊息照樣收得到。
   */
  private static singleFrameLimitFor(peer: PeerInfo): number {
    const advertised = peer.connection.sctp?.maxMessageSize;
    return typeof advertised === 'number' && advertised > 0 ? advertised : 262_144;
  }
  /** 送出緩衝（bufferedAmount）快滿時不送分塊訊息，留在 outbox（Chromium 上限 16MB，滿了 send 會 throw） */
  private static readonly DC_SEND_BUFFER_LIMIT = 12 * 1024 * 1024;

  /** e2e 用：被模擬成「死掉」的 peer（丟棄其 inbound）。release build 永遠空。 */
  private simulatedDeadPeers: Set<string> = new Set();
  peerPubkeys(): string[] {
    return [...this.peers.keys()];
  }
  simulateDcDeath(remotePublicKeyBase64: string): void {
    this.simulatedDeadPeers.add(remotePublicKeyBase64);
  }
  dcHealthSnapshot(remotePublicKeyBase64: string): Record<string, unknown> {
    const peer = this.peers.get(remotePublicKeyBase64);
    const last = this.lastDcInboundAt.get(remotePublicKeyBase64);
    return {
      dcState: peer?.dataChannel?.readyState ?? null,
      connState: peer?.connection.connectionState ?? null,
      hbCapable: this.hbCapablePeers.has(remotePublicKeyBase64),
      msSinceInbound: last === undefined ? null : Date.now() - last,
      stale: this.isDcStale(remotePublicKeyBase64),
      open: this.isDataChannelOpen(remotePublicKeyBase64),
    };
  }

  // 行動端原生螢幕投放接收用：獨立專用的螢幕接收 PeerConnection,keyed by sender pubkey。
  // 原生 sender(iOS Broadcast Extension / Android MediaProjection)的 video 在它自己的
  // native PC 上(獨立 DTLS/ICE 端點),不能套用到既有 file PC,所以接收端要建第二條 PC。
  // 桌面 sender 的「renegotiate on file PC」路徑不經過這裡(維持原狀)。
  private screenRecvPeers: Map<string, RTCPeerConnection> = new Map();

  // 事件監聽器
  private messageListeners: Set<MessageCallback> = new Set();
  private stateListeners: Set<StateCallback> = new Set();
  private dataChannelStateListeners: Set<DataChannelStateCallback> = new Set();
  private mediaStreamListeners: Set<MediaStreamCallback> = new Set();

  // MQTT 訂閱取消函式
  private mqttUnsubscribes: (() => void)[] = [];

  /**
   * 初始化 WebRTC 服務
   */
  initialize(localPublicKeyBase64: string): void {
    // 防止重複初始化（同一 key 不需要重新訂閱 MQTT）
    if (this.localPublicKeyBase64 === localPublicKeyBase64 && this.mqttUnsubscribes.length > 0) {
      return;
    }
    // 清理舊的訂閱（如果換了 key）
    if (this.mqttUnsubscribes.length > 0) {
      this.mqttUnsubscribes.forEach((unsub) => unsub());
      this.mqttUnsubscribes = [];
    }
    this.localPublicKeyBase64 = localPublicKeyBase64;

    // 訂閱 MQTT 信令訊息
    this.mqttUnsubscribes.push(
      mqttService.onMessage(MessageType.WEBRTC_OFFER, (msg) => this.handleOffer(msg)),
      mqttService.onMessage(MessageType.WEBRTC_ANSWER, (msg) => this.handleAnswer(msg)),
      mqttService.onMessage(MessageType.WEBRTC_ICE, (msg) => this.handleIceCandidate(msg)),
      // dedicated 螢幕接收 PC 的 trickle ICE(來自原生 sender)。只有存在 screenRecvPeer 才套用,
      // 否則 ignore(可能是 file PC 的舊訊息誤投或 stale)。
      mqttService.onMessage(MessageType.SCREEN_SHARE_ICE, (msg) => { void this.handleScreenShareIce(msg); })
    );

    diagLog('[DIAG:WebRTC] Service initialized, MQTT offer/answer/ICE listeners registered');
    devLog('[WebRTC] Service initialized');
  }

  /**
   * 誰可以對我發 offer（稽核 B1）：以前任何 from 都接，被撤銷的裝置能重建 DataChannel 繼續收發。
   * peerSync 設成「仍是本帳號裝置」。沒設定時一律接受。
   */
  private inboundPolicy: ((peer: string) => Promise<boolean>) | null = null;

  setInboundPolicy(policy: ((peer: string) => Promise<boolean>) | null): void {
    this.inboundPolicy = policy;
  }

  /**
   * 還沒有這個 peer 時先到的 ICE（offer 還在等 inbound policy／GET /devices；對方 offer 後約 100 ms 就 trickle）。
   * 以前直接丟 → restrictive NAT 後面缺候選、卡 checking（AegisTrans 審查 C）。每台最多 32 個、最多 16 台、
   * 從第一個起 30 秒內有效；建 responder 時補上，policy 拒絕就丟掉。
   */
  private earlyCandidates = new Map<string, { at: number; candidates: RTCIceCandidateInit[] }>();
  private static readonly EARLY_ICE_MAX = 32;
  private static readonly EARLY_ICE_PEERS_MAX = 16;
  private static readonly EARLY_ICE_TTL_MS = 30_000;

  private bufferEarlyCandidate(remotePublicKeyBase64: string, candidate: RTCIceCandidateInit): void {
    const now = Date.now();
    for (const [key, entry] of this.earlyCandidates) {
      if (now - entry.at > WebRTCService.EARLY_ICE_TTL_MS) this.earlyCandidates.delete(key);
    }
    let entry = this.earlyCandidates.get(remotePublicKeyBase64);
    if (!entry) {
      if (this.earlyCandidates.size >= WebRTCService.EARLY_ICE_PEERS_MAX) return;
      entry = { at: now, candidates: [] };
      this.earlyCandidates.set(remotePublicKeyBase64, entry);
    }
    if (entry.candidates.length < WebRTCService.EARLY_ICE_MAX) entry.candidates.push(candidate);
  }

  /** 交給剛建的 responder（過期的不用） */
  private takeEarlyCandidates(remotePublicKeyBase64: string): RTCIceCandidateInit[] {
    const entry = this.earlyCandidates.get(remotePublicKeyBase64);
    this.earlyCandidates.delete(remotePublicKeyBase64);
    return entry && Date.now() - entry.at <= WebRTCService.EARLY_ICE_TTL_MS ? entry.candidates : [];
  }

  /**
   * 關閉服務
   */
  shutdown(): void {
    // 取消 MQTT 訂閱
    this.mqttUnsubscribes.forEach((unsub) => unsub());
    this.mqttUnsubscribes = [];
    this.inboundPolicy = null;
    this.earlyCandidates.clear();

    // 關閉所有連線
    this.peers.forEach((peer) => {
      peer.dataChannel?.close();
      peer.connection.close();
    });
    this.peers.clear();

    // 關閉所有 dedicated 螢幕接收 PC
    this.screenRecvPeers.forEach((pc) => { try { pc.close(); } catch { /* ignore */ } });
    this.screenRecvPeers.clear();

    // 停心跳 timer（否則登出/換帳號後每 10s 對空 peers map 空轉不止）+ 清能力快取
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    this.hbCapablePeers.clear();
    this.lastDcInboundAt.clear();

    this.localPublicKeyBase64 = null;
    devLog('[WebRTC] Service shut down');
  }

  /** PC 卡在 new/connecting/checking、DataChannel 未 open、且本輪嘗試已超過 deadline → 該重建。 */
  private isStaleStuck(remotePublicKeyBase64: string, peer: PeerInfo): boolean {
    if (peer.dataChannel?.readyState === 'open') return false;
    // 只算「握手早期就卡死」：connected/completed 的活 PC（DataChannel 暫關）走 reopen-in-place，
    //   絕不在此重建 → 不碰活連線、不重蹈死亡螺旋。
    const cs = peer.connection.connectionState;
    const ice = peer.connection.iceConnectionState;
    const earlyPhase = cs === 'new' || cs === 'connecting' || ice === 'new' || ice === 'checking';
    if (!earlyPhase) return false;
    const started = this.connectAttemptAt.get(remotePublicKeyBase64);
    return started !== undefined && Date.now() - started > WebRTCService.STUCK_REBUILD_MS;
  }

  /**
   * 發起連線到指定 Peer
   */
  async connect(remotePublicKeyBase64: string): Promise<void> {
    if (!this.localPublicKeyBase64) {
      throw new Error('WebRTC service not initialized');
    }

    const existingPeer = this.peers.get(remotePublicKeyBase64);
    if (existingPeer) {
      const connState = existingPeer.connection.connectionState;
      const iceState = existingPeer.connection.iceConnectionState;
      const dcState = existingPeer.dataChannel?.readyState;

      // DataChannel 已開啟 → 不重連。但「open 且心跳還在」才算真的開；心跳斷掉的殭屍
      // 通道必須往下走重建，否則就是本次事故：全系統自認健康、永不自救（trace 實證兩台
      // 之間 30 分鐘零 signaling）。
      if (dcState === 'open' && !this.isDcStale(remotePublicKeyBase64)) {
        devLog(`[WebRTC] Already connected to ${remotePublicKeyBase64.slice(0, 8)}...`);
        return;
      }
      if (dcState === 'open') {
        // 殭屍：砍掉 → 往下走 fresh rebuild（不能走 reopen-in-place，PC 本身的傳輸已死）
        diagLog('[DIAG:WebRTC] Zombie DC (open but heartbeat stale) → teardown + rebuild:', remotePublicKeyBase64.slice(0, 16));
        this.closePeer(remotePublicKeyBase64);
      } else {
      const inProgress = connState === 'new' || connState === 'connecting' ||
        iceState === 'new' || iceState === 'checking';
      if (inProgress && !this.isStaleStuck(remotePublicKeyBase64, existingPeer)) {
        // 連線進行中且還在 deadline 內 → 等待，不打斷
        diagLog('[DIAG:WebRTC] Connection in progress, waiting:', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        return;
      }
      if (inProgress) {
        // 🔑 livelock 修復(port AegisTalk)：卡在 new/connecting/checking、DataChannel 從未 open
        //   超過 deadline → offer 多半送進已死的對端（peer full restart）；原地 reopen/等待都無效
        //   → 砍掉重建 fresh。peerHealthMonitor 反覆 reconnect 但 connect() 早退的死局就靠這裡破。
        diagLog('[DIAG:WebRTC] Stuck (no DataChannel past deadline) → teardown + fresh rebuild:', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        this.closePeer(remotePublicKeyBase64);
        // ↓ fall through to fresh connect
      } else if (connState !== 'failed' && connState !== 'closed' && iceState !== 'failed') {
        // 🔑 根因修復(port AegisTalk)：PC 仍活著(connected/disconnected)但 DataChannel 沒開 → 絕不
        //   closePeer 重建。重建會與對端各自重建互相搶 → PC 世代錯位 → channel 開了又關、永不收斂。
        //   改在同一條 PC 上原地 renegotiation 重開 DataChannel，且只有單一發起者(impolite)動作。
        diagLog('[DIAG:WebRTC] Live PC, DC not open → reopen channel in-place:', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        await this.reopenDataChannelInPlace(remotePublicKeyBase64);
        return;
      } else {
        // 真的死了(failed/closed) → 清理後重連
        diagLog('[DIAG:WebRTC] Cleaning dead peer (rebuild):', remotePublicKeyBase64.slice(0, 16), `conn=${connState} ice=${iceState}`);
        this.closePeer(remotePublicKeyBase64);
      }
      } // end: 非殭屍分支
    }

    devLog(`[WebRTC] Initiating connection to ${remotePublicKeyBase64.slice(0, 8)}...`);

    // 建立 RTCPeerConnection
    const connection = this.createPeerConnection(remotePublicKeyBase64);

    // 建立資料通道
    const dataChannel = connection.createDataChannel('mist', {
      ordered: true,
    });
    this.setupDataChannel(dataChannel, remotePublicKeyBase64);

    // 儲存 Peer 資訊
    this.connectAttemptAt.set(remotePublicKeyBase64, Date.now()); // 本輪握手起算（stuck 重建判斷用）
    this.peers.set(remotePublicKeyBase64, {
      publicKeyBase64: remotePublicKeyBase64,
      connection,
      dataChannel,
      connectionState: PeerConnectionState.CONNECTING,
      dataChannelState: DataChannelState.CONNECTING,
      isInitiator: true,
      pendingCandidates: [],
      candidateFlushTimer: null,
      incomingCandidates: [],
    });

    // 建立 Offer（Perfect Negotiation：makingOffer 期間若收到對方 offer = collision）
    this.makingOffer.add(remotePublicKeyBase64);
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      // 透過 MQTT 發送 Offer
      mqttService.sendOffer(remotePublicKeyBase64, offer);
      devLog(`[WebRTC] Sent offer to ${remotePublicKeyBase64.slice(0, 8)}...`);
    } catch (error) {
      console.error('[WebRTC] Failed to create offer:', error);
      this.closePeer(remotePublicKeyBase64);
      throw error;
    } finally {
      this.makingOffer.delete(remotePublicKeyBase64);
    }
  }

  /**
   * 🔑 根因修復(port AegisTalk)：DataChannel 關閉但 PC 仍活著時，在同一條 RTCPeerConnection 上
   *   原地重開 channel，不拆 PC（拆 PC → 雙方各自重建、PC 世代錯位、永不收斂）。只有 impolite
   *   (pubkey 較大)重開並送 offer；polite 端等 impolite re-offer，其 handleOffer 走 PerfectNeg 回 answer。
   */
  private async reopenDataChannelInPlace(remotePublicKeyBase64: string): Promise<void> {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return;

    const polite = !!this.localPublicKeyBase64 && this.localPublicKeyBase64 < remotePublicKeyBase64;
    if (polite) {
      diagLog('[DIAG:WebRTC] reopen: polite side waits for impolite re-offer:', remotePublicKeyBase64.slice(0, 16));
      return;
    }
    if (this.makingOffer.has(remotePublicKeyBase64) || peer.connection.signalingState !== 'stable') {
      diagLog('[DIAG:WebRTC] reopen: skip (offer/negotiation in progress):', remotePublicKeyBase64.slice(0, 16), `sig=${peer.connection.signalingState}`);
      return;
    }

    diagLog('[DIAG:WebRTC] reopen DataChannel in-place (same PC, NO teardown):', remotePublicKeyBase64.slice(0, 16));
    this.connectAttemptAt.set(remotePublicKeyBase64, Date.now()); // 新一輪 renegotiation 嘗試起算
    const dataChannel = peer.connection.createDataChannel('mist', { ordered: true });
    this.setupDataChannel(dataChannel, remotePublicKeyBase64);
    peer.dataChannel = dataChannel;
    peer.isInitiator = true;

    this.makingOffer.add(remotePublicKeyBase64);
    try {
      const offer = await peer.connection.createOffer();
      await peer.connection.setLocalDescription(offer);
      mqttService.sendOffer(remotePublicKeyBase64, offer);
      devLog(`[WebRTC] Re-offered (reopen DC) to ${remotePublicKeyBase64.slice(0, 8)}...`);
    } catch (error) {
      console.error('[WebRTC] reopen renegotiation failed:', error);
    } finally {
      this.makingOffer.delete(remotePublicKeyBase64);
    }
  }

  /**
   * 斷開與指定 Peer 的連線
   */
  disconnect(remotePublicKeyBase64: string): void {
    this.closePeer(remotePublicKeyBase64);
  }

  /**
   * P2P 健康檢查:DataChannel 真的 open 才算健康（給 peerHealthMonitor watchdog 用）。
   * conn=connecting / ice=checking 卡住、或根本沒 peer entry,一律不健康 → 該重連。
   */
  isPeerHealthy(remotePublicKeyBase64: string): boolean {
    return this.isDataChannelOpen(remotePublicKeyBase64);
  }

  /** 殭屍 DC（open 但心跳斷）→ 對外一律當「沒開」：watchdog 會重建，訊息進 outbox 不蒸發。 */
  isPeerZombie(remotePublicKeyBase64: string): boolean {
    return this.isDcStale(remotePublicKeyBase64);
  }

  /**
   * 連線是否已進入「終端 failed」狀態(ICE 或 connection state === 'failed') → 死了、要重建。
   * peerHealthMonitor 用:presence 可能 stale(對方其實還在、卻回報 offline)→ 光靠 presence 判斷會
   * 讓 failed 的 peer 沒人救(實測失敗後卡 6 分鐘,直到對方剛好送 offer 才靠 §6 handleOffer 復原)。
   * 「connectionState==='failed'」是直接證據、不是 presence 猜測 → 據此主動重連。
   * 只認 'failed'(終端、不自復);'disconnected' 是暫時、ICE 會自己嘗試恢復,不在此列(否則會打斷自復)。
   */
  isPeerFailed(remotePublicKeyBase64: string): boolean {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return false;
    return peer.connection.connectionState === 'failed'
      || peer.connection.iceConnectionState === 'failed';
  }

  /**
   * DataChannel 是否真的可送（給 p2pSend / fileTransfer 判斷「已連線」用）。
   * ⚠️ 真因(port AegisTalk)：PC 已 failed/disconnected/closed 後 dataChannel.readyState 仍殘留
   *   'open' → 送進去丟黑洞、訊息不進 outbox → 換網/背景喚醒後雙方互傳都收不到。必須同時確認
   *   connection 本身還活著，否則一律當未連線 → 進持久化 outbox 等重連 flush。
   */
  isDataChannelOpen(remotePublicKeyBase64: string): boolean {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer?.dataChannel?.readyState !== 'open') return false;
    const cs = peer.connection.connectionState;
    if (cs === 'failed' || cs === 'disconnected' || cs === 'closed') return false;
    // 殭屍：readyState 'open' + PC 'connected'，但心跳早就斷了 → 送進去會蒸發，當作沒開
    return !this.isDcStale(remotePublicKeyBase64);
  }

  /**
   * 發送資料到指定 Peer
   */
  send(remotePublicKeyBase64: string, data: ArrayBuffer | string): boolean {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
      devWarn(`[WebRTC] Cannot send to ${remotePublicKeyBase64.slice(0, 8)}...: channel not open`);
      return false;
    }

    try {
      if (typeof data === 'string') {
        // 超過 DataChannel 單則上限的字串切塊送（傳輸統一 X5）；以前直接 throw → 回 false → outbox 卡死
        const partLimit = WebRTCService.frameLimitFor(peer);
        let frames = splitFrame(data, partLimit, WebRTCService.singleFrameLimitFor(peer));
        if (frames?.length === 1 && data.length * 3 > partLimit && utf8Length(data) > partLimit) {
          // 超過分塊片長、但在對端宣告的上限內 → 照舊單幀送。對端宣告的比本機實際能送的大
          //   （例如 Firefox 宣告 1GB、Chromium 只能送 256KB）時 send 會丟錯，這時才改分塊
          try {
            peer.dataChannel.send(data);
            return true;
          } catch {
            frames = splitFrame(data, partLimit);
          }
        }
        if (!frames) {
          console.error('[WebRTC] Message too large for DataChannel:', data.length, 'chars');
          return false;
        }
        if (frames.length > 1 && peer.dataChannel.bufferedAmount + data.length > WebRTCService.DC_SEND_BUFFER_LIMIT) {
          devWarn('[WebRTC] Send buffer nearly full; leaving the large message in the outbox');
          return false;
        }
        for (const frame of frames) peer.dataChannel.send(frame);
      } else {
        peer.dataChannel.send(data);
      }
      return true;
    } catch (error) {
      console.error('[WebRTC] Failed to send:', error);
      return false;
    }
  }

  /**
   * 廣播資料到所有已連線的 Peers
   */
  broadcast(data: ArrayBuffer | string): void {
    this.peers.forEach((peer, key) => {
      if (peer.dataChannel?.readyState === 'open') {
        this.send(key, data);
      }
    });
  }

  /**
   * 取得所有已連線的 Peers
   */
  getConnectedPeers(): string[] {
    return Array.from(this.peers.entries())
      .filter(([_, peer]) => peer.connectionState === PeerConnectionState.CONNECTED)
      .map(([key]) => key);
  }

  /**
   * 取得 Peer 連線狀態
   */
  getPeerState(remotePublicKeyBase64: string): PeerConnectionState | null {
    return this.peers.get(remotePublicKeyBase64)?.connectionState ?? null;
  }

  /**
   * 監聽收到的訊息
   */
  onMessage(callback: MessageCallback): () => void {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  /**
   * 監聯連線狀態變化
   */
  onStateChange(callback: StateCallback): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /**
   * 監聽資料通道狀態變化
   */
  onDataChannelStateChange(callback: DataChannelStateCallback): () => void {
    this.dataChannelStateListeners.add(callback);
    return () => this.dataChannelStateListeners.delete(callback);
  }

  /**
   * Phase 2：監聽遠端 MediaStream 抵達（addTrack ontrack 觸發）
   *
   * mediaChannel.ts 透過此 API 接收 peer 推來的 video / audio stream。
   * 同 peer 多次 addTrack 會觸發多次 callback（kind 不同的 tracks 可能分批到）。
   * 接收端要 cache 第一個 stream 並後續以 stream.id 比對；不同 stream 視為新會話。
   */
  onMediaStream(callback: MediaStreamCallback): () => void {
    this.mediaStreamListeners.add(callback);
    return () => this.mediaStreamListeners.delete(callback);
  }

  /**
   * Phase 2：取得既有 PeerConnection（給 mediaChannel.ts 做 addTrack / removeTrack）。
   *
   * mediaChannel 不另開 PC，重用 file DataChannel 那條已建立的連線；同一條 PC
   * 上同時跑檔案 DataChannel + 螢幕分享 video track。若 peer 還沒連 → null，
   * 呼叫端應先 `connectToPeer` 或排到 outbox 等 DataChannel OPEN。
   */
  getPeerConnection(remotePublicKeyBase64: string): RTCPeerConnection | null {
    return this.peers.get(remotePublicKeyBase64)?.connection ?? null;
  }

  // ============================================
  // Dedicated 螢幕接收 PeerConnection（行動端原生發送的接收端）
  // ============================================

  /**
   * 為「原生 sender 的螢幕投放」建立一條獨立、僅接收的 PeerConnection。
   *
   * 為何不重用 file PC：原生 sender(iOS Broadcast Extension / Android MediaProjection)
   * 的 video 在它自己的 native RTCPeerConnection 上(獨立 DTLS fingerprint + ICE),
   * 接收端的單一 file PC 無法同時對應兩個不同的遠端 DTLS 端點 → 必須開第二條。
   *
   * ICE：走全新 trickle(此 PC 是全新端點,沒有既有 ICE 可重用),candidate 經
   * SCREEN_SHARE_ICE 送回 sender；同樣過濾 relay(TURN 禁用)。
   * ontrack：重用 mediaStreamListeners fan-out → mediaChannel / RemoteScreenViewer 完全不變。
   */
  createScreenReceivePeer(peerPublicKeyBase64: string): RTCPeerConnection {
    // 已有就先關掉(重投/重連)
    this.closeScreenReceivePeer(peerPublicKeyBase64);

    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 10,
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;  // gathering 完成
      // ❌ 過濾 relay candidates — 資料不可經過 TURN（純 P2P 原則）
      if (event.candidate.type === 'relay' || event.candidate.candidate?.includes('relay')) {
        devLog('[WebRTC] ❌ Filtered relay candidate on screen-recv PC (TURN disabled)');
        return;
      }
      // dedicated 螢幕 PC 直接 trickle（不走 file PC 的 IPv6 排序佇列）
      mqttService.sendToUser(peerPublicKeyBase64, MessageType.SCREEN_SHARE_ICE, {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? null,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
      });
      diagLog('[NSDIAG-RX] sent recv-side ICE to', peerPublicKeyBase64.slice(0, 12));
    };

    pc.oniceconnectionstatechange = () => {
      diagLog('[NSDIAG-RX] screen-recv ICE state:', pc.iceConnectionState);
    };

    pc.ontrack = (event) => {
      // 行動端原生 sender(iOS Broadcast Extension)的 offer 沒帶 stream id → SDP 是
      // `a=msid:- screen0`(- = 無 MediaStream)→ 接收端 event.streams 為空。spec 仍保證
      // event.track 存在,故用 track 自建 MediaStream 兜底。桌面 renegotiate 路徑帶
      // streams(mediaChannel addTrack streams:[stream]),event.streams[0] 直接有值不受影響。
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      diagLog('[NSDIAG-RX] screen-recv ontrack from', peerPublicKeyBase64.slice(0, 12),
        'kind', event.track.kind, 'streams', event.streams.length,
        event.streams[0] ? 'real-stream' : 'track-fallback');
      this.mediaStreamListeners.forEach((cb) => {
        try { cb(peerPublicKeyBase64, stream); }
        catch (err) { console.error('[WebRTC] mediaStream listener threw:', err); }
      });
    };

    this.screenRecvPeers.set(peerPublicKeyBase64, pc);
    diagLog('[DIAG:WebRTC] created dedicated screen-recv PC for', peerPublicKeyBase64.slice(0, 16));
    return pc;
  }

  getScreenReceivePeer(peerPublicKeyBase64: string): RTCPeerConnection | null {
    return this.screenRecvPeers.get(peerPublicKeyBase64) ?? null;
  }

  closeScreenReceivePeer(peerPublicKeyBase64: string): void {
    const pc = this.screenRecvPeers.get(peerPublicKeyBase64);
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
      this.screenRecvPeers.delete(peerPublicKeyBase64);
      diagLog('[DIAG:WebRTC] closed dedicated screen-recv PC for', peerPublicKeyBase64.slice(0, 16));
    }
  }

  /**
   * 收到 dedicated 螢幕 PC 的 trickle ICE。只在已有 screenRecvPeer 時套用;
   * 否則 ignore(原生 sender 端的 ICE 由 nativeScreenSender → plugin 處理,不在此)。
   */
  private async handleScreenShareIce(msg: MqttMessage): Promise<void> {
    const peerPk = msg.from;
    const pc = this.screenRecvPeers.get(peerPk);
    if (!pc) {
      // 沒有對應的接收 PC — 可能本機是 sender 端(ICE 給 native plugin,不在此處理),或 stale。
      return;
    }
    try {
      const init = msg.payload as RTCIceCandidateInit;
      if (!init || !init.candidate) return;
      await pc.addIceCandidate(init);
      diagLog('[NSDIAG-RX] applied sender ICE on screen-recv PC');
    } catch (err) {
      devWarn('[WebRTC] screen-recv addIceCandidate failed:', (err as Error).message);
    }
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * 建立 RTCPeerConnection
   */
  private createPeerConnection(remotePublicKeyBase64: string): RTCPeerConnection {
    const connection = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 10,
    });

    // ICE Candidate 事件 - IPv6 優先處理，過濾 relay（TURN）candidates
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        // ❌ 過濾 relay candidates — 訊息內容不可經過 TURN 伺服器
        if (event.candidate.type === 'relay' || event.candidate.candidate?.includes('relay')) {
          devLog(`[WebRTC] ❌ Filtered relay candidate (TURN disabled)`);
          return;
        }
        if (IPV6_FIRST_ENABLED) {
          // 收集 candidates，延遲發送以便排序
          this.queueCandidate(remotePublicKeyBase64, event.candidate);
        } else {
          // 不啟用 IPv6 優先時，直接發送
          mqttService.sendIceCandidate(remotePublicKeyBase64, event.candidate);
        }
      } else {
        // ICE gathering 完成，立即發送所有暫存的 candidates
        if (IPV6_FIRST_ENABLED) {
          this.flushCandidates(remotePublicKeyBase64);
        }
      }
    };

    // ICE 連線狀態變化
    connection.oniceconnectionstatechange = () => {
      const state = this.mapIceConnectionState(connection.iceConnectionState);
      this.updatePeerState(remotePublicKeyBase64, state);

      // 連線成功時，記錄使用的連線類型
      if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') {
        this.logConnectionType(connection, remotePublicKeyBase64);
      }
    };

    // 連線狀態變化
    connection.onconnectionstatechange = () => {
      const state = this.mapConnectionState(connection.connectionState);
      this.updatePeerState(remotePublicKeyBase64, state);
    };

    // Perfect Negotiation: initiators can rollback and become answerers, so every
    // connection must be ready to receive the peer's reopened DataChannel.
    connection.ondatachannel = (event) => {
      // 不在此立刻 peer.dataChannel = event.channel:新收到的通道可能還沒 open,立刻覆蓋 send slot
      //   會把「正在用、還開著」的舊通道換成半開通道 → send 壞掉(對端仍從舊通道收 = 收得到卻送不出)。
      //   只 setupDataChannel(掛 onopen/onmessage);等它 onopen 真的開了,再由 onopen promote 成 send slot。
      //   onmessage 立即生效 → 收訊不受影響。
      this.setupDataChannel(event.channel, remotePublicKeyBase64);
    };

    // Phase 2：遠端送來 video / audio track 時觸發 — 雙向都要 wire（initiator
    // 也可能是 receiver 角色）。webrtc.ts 不解析 stream 內容，只把 first
    // stream 廣播給 mediaChannel.ts 處理。同 PeerConnection 多次 addTrack
    // 會觸發多個 ontrack；都只取 event.streams[0]（這是 RTCRtpReceiver 的
    // associated MediaStream，瀏覽器會自動把同一 stream 的 tracks 聚合進來）。
    connection.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) {
        devWarn('[WebRTC] ontrack fired without associated stream');
        return;
      }
      diagLog('[DIAG:WebRTC] ontrack stream from:', remotePublicKeyBase64.slice(0, 16),
        'kind:', event.track.kind, 'streamId:', stream.id.slice(0, 12));
      this.mediaStreamListeners.forEach((cb) => {
        try { cb(remotePublicKeyBase64, stream); }
        catch (err) { console.error('[WebRTC] mediaStream listener threw:', err); }
      });
    };

    return connection;
  }

  /**
   * 設定資料通道事件處理
   */
  private setupDataChannel(channel: RTCDataChannel, remotePublicKeyBase64: string): void {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      diagLog('[DIAG:WebRTC] DataChannel OPEN with:', remotePublicKeyBase64.slice(0, 16));
      this.connectAttemptAt.delete(remotePublicKeyBase64); // 連上了 → 清掉本輪嘗試計時
      this.lastDcInboundAt.set(remotePublicKeyBase64, Date.now()); // 心跳寬限從此刻起算
      this.startHeartbeat();
      // 🔑「收得到卻送不出」修復:send() 只認 peer.dataChannel 這一個 slot。多通道情境
      //   (自建 + ondatachannel 收到 + reopen 新建)slot 可能被換成「還沒 open / 半開」的通道,
      //   而對端訊息卻從另一條已 open 的通道進來(onmessage 每條都掛)→ 收得到、送失敗。
      //   對策:哪條通道「真的 open 了」才把它設為 send slot → send 永遠用一條確定開著的通道。
      const peer = this.peers.get(remotePublicKeyBase64);
      if (peer) peer.dataChannel = channel;
      this.updateDataChannelState(remotePublicKeyBase64, DataChannelState.OPEN);
    };

    channel.onclose = () => {
      devLog(`[WebRTC] Data channel closed with ${remotePublicKeyBase64.slice(0, 8)}...`);
      this.updateDataChannelState(remotePublicKeyBase64, DataChannelState.CLOSED);
    };

    channel.onerror = (error) => {
      console.error(`[WebRTC] Data channel error with ${remotePublicKeyBase64.slice(0, 8)}...:`, error);
    };

    channel.onmessage = (event) => {
      // e2e only：模擬「傳輸已死但 readyState 仍 open」的殭屍通道 —— 丟棄所有進來的資料，
      // readyState 不動。release build 這個 set 永遠是空的。
      if (this.simulatedDeadPeers.has(remotePublicKeyBase64)) return;
      // 任何進來的資料都證明通道還活著（含心跳）
      this.lastDcInboundAt.set(remotePublicKeyBase64, Date.now());
      if (event.data === WebRTCService.DC_HEARTBEAT_FRAME) {
        // 對端會送心跳 → 這條 peer 可套用 staleness 判定
        this.hbCapablePeers.add(remotePublicKeyBase64);
        return; // 心跳不進應用層
      }
      // 分塊幀（dcFraming，傳輸統一 X5）：湊齊才往上送整則訊息
      let data = event.data;
      const peer = this.peers.get(remotePublicKeyBase64);
      if (typeof data === 'string' && peer) {
        if (!peer.rxFrames) peer.rxFrames = new FrameAssembler();
        const whole = peer.rxFrames.push(data);
        if (whole === null) return;
        if (whole !== undefined) data = whole;
      }
      this.messageListeners.forEach((callback) => {
        callback(remotePublicKeyBase64, data);
      });
    };
  }

  /** DC 心跳：每 DC_HEARTBEAT_MS 對所有 open 的通道送一幀。單一 timer，全 peer 共用。 */
  private startHeartbeat(): void {
    if (this.hbTimer) return;
    this.hbTimer = setInterval(() => {
      for (const [pk, peer] of this.peers) {
        if (peer.dataChannel?.readyState !== 'open') continue;
        try {
          peer.dataChannel.send(WebRTCService.DC_HEARTBEAT_FRAME);
        } catch {
          // send 失敗 = 通道真的壞了；staleness 會接手判死，這裡不動作
        }
        void pk;
      }
    }, WebRTCService.DC_HEARTBEAT_MS);
  }

  /**
   * DC 是「open 但已死」的殭屍嗎？
   * 只對「會送心跳的對端」判定（舊版對端沒心跳 → 永遠回 false，維持舊行為）。
   *
   * 已知窗口：連線開啟到「收到第一個心跳」之間（~10-20s）此 peer 還不是 hbCapable → 這裡回
   * false。這是刻意的相容性代價（無法在收到心跳前得知對端會不會送心跳，強行提早標記會把不送
   * 心跳的舊版對端誤殺）。這段窗口的傳輸死亡由 isDataChannelOpen 的 connectionState 檢查
   * （failed/disconnected/closed → not open）與 peerHealthMonitor 的 isPeerFailed 兜底 —— 只有
   * 「ICE 卡在 connected 但傳輸已死」這種罕見病理會漏，且下一個心跳週期一旦收到就進入正常判定。
   */
  private isDcStale(remotePublicKeyBase64: string): boolean {
    if (!this.hbCapablePeers.has(remotePublicKeyBase64)) return false;
    const last = this.lastDcInboundAt.get(remotePublicKeyBase64);
    if (last === undefined) return false;
    return Date.now() - last > WebRTCService.DC_STALE_MS;
  }

  /**
   * 處理收到的 Offer
   */
  private async handleOffer(msg: MqttMessage): Promise<void> {
    const remotePublicKeyBase64 = msg.from;
    const offer = msg.payload as RTCSessionDescriptionInit;

    diagLog('[DIAG:WebRTC] Received offer from:', remotePublicKeyBase64.slice(0, 16));
    devLog(`[WebRTC] Received offer from ${remotePublicKeyBase64.slice(0, 8)}...`);

    if (this.inboundPolicy && !(await this.inboundPolicy(remotePublicKeyBase64))) {
      devWarn(`[WebRTC] Offer from ${remotePublicKeyBase64.slice(0, 8)}... rejected by inbound policy (not an account device)`);
      this.earlyCandidates.delete(remotePublicKeyBase64);
      return;
    }

    const existingPeer = this.peers.get(remotePublicKeyBase64);
    if (existingPeer) {
      // 🔑 根因修復(port AegisTalk)：只有「PC 真的終止」(failed/closed) 才算死、才重建。
      //   DataChannel 關閉 / 暫時 disconnected 都不算死 → 保留同一條 PC，走 Perfect Negotiation。
      const existingDead =
        existingPeer.connectionState === PeerConnectionState.FAILED ||
        existingPeer.connectionState === PeerConnectionState.CLOSED;
      // 對端送 fresh offer、但我方對它的 PC 早就卡死(new/checking、DataChannel 從未 open 超過 deadline，
      //   例：對端完整重啟) → 在這條死 PC 上跑 PerfectNeg 回 answer 也連不上 → 砍掉建 fresh responder。
      const staleStuck = this.isStaleStuck(remotePublicKeyBase64, existingPeer);

      if (!existingDead && !staleStuck) {
        // Perfect Negotiation（W3C/MDN）：impolite(pubkey 較大)+collision → 忽略對方 offer（保留自己的
        //   offer，等對方 answer）；polite 或非 collision → setRemoteDescription(offer)（have-local-offer
        //   時隱式 rollback）→ 同一連線回 answer，不拆連線、不丟 ICE。舊作法 glare 時 closePeer 重建會
        //   丟進行中的 ICE → 卡 conn=new。
        const pc = existingPeer.connection;
        const polite = !!this.localPublicKeyBase64 && this.localPublicKeyBase64 < remotePublicKeyBase64;
        const collision = this.makingOffer.has(remotePublicKeyBase64) || pc.signalingState !== 'stable';

        if (collision && !polite) {
          diagLog('[DIAG:WebRTC] PerfectNeg impolite IGNORING colliding offer:', remotePublicKeyBase64.slice(0, 16), `sig=${pc.signalingState}`);
          return;
        }
        try {
          diagLog(`[DIAG:WebRTC] PerfectNeg accept offer polite=${polite} collision=${collision} sig=${pc.signalingState}:`, remotePublicKeyBase64.slice(0, 16));
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
          await this.flushIncomingCandidates(remotePublicKeyBase64);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          mqttService.sendAnswer(remotePublicKeyBase64, answer);
          existingPeer.isInitiator = false; // 我方現在是 answerer
          diagLog('[DIAG:WebRTC] PerfectNeg sent answer on SAME connection:', remotePublicKeyBase64.slice(0, 16));
        } catch (error) {
          console.error('[WebRTC] PerfectNeg failed, falling back to rebuild:', error);
          this.closePeer(remotePublicKeyBase64);
          await this.createResponderConnection(remotePublicKeyBase64, offer);
        }
        return;
      }

      // 既有連線真的死了/卡死 → 合法重連：closePeer + 建新 responder
      diagLog('[DIAG:WebRTC] Existing peer DEAD/STUCK - rebuild responder:', remotePublicKeyBase64.slice(0, 16), `conn=${existingPeer.connectionState} stuck=${staleStuck}`);
      this.closePeer(remotePublicKeyBase64);
    }

    // 沒有既有 peer（或 dead 已關）→ 建新 responder 連線並回 answer
    await this.createResponderConnection(remotePublicKeyBase64, offer);
  }

  /** 建新 responder 連線並回 answer（一般非 glare 路徑 / dead 重連用）。 */
  private async createResponderConnection(remotePublicKeyBase64: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const connection = this.createPeerConnection(remotePublicKeyBase64);
    this.connectAttemptAt.set(remotePublicKeyBase64, Date.now()); // responder 握手起算（stuck 重建判斷用）
    this.peers.set(remotePublicKeyBase64, {
      publicKeyBase64: remotePublicKeyBase64,
      connection,
      dataChannel: null,
      connectionState: PeerConnectionState.CONNECTING,
      dataChannelState: DataChannelState.CONNECTING,
      isInitiator: false,
      pendingCandidates: [],
      candidateFlushTimer: null,
      incomingCandidates: this.takeEarlyCandidates(remotePublicKeyBase64),   // 等 policy 時先到的 ICE
    });

    try {
      await connection.setRemoteDescription(new RTCSessionDescription(offer));
      // remoteDescription 已 set → 補加先前因「還沒 set」而 buffer 的早到 candidate
      await this.flushIncomingCandidates(remotePublicKeyBase64);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      mqttService.sendAnswer(remotePublicKeyBase64, answer);
      diagLog('[DIAG:WebRTC] Sent answer to:', remotePublicKeyBase64.slice(0, 16));
    } catch (error) {
      console.error('[WebRTC] Failed to handle offer:', error);
      this.closePeer(remotePublicKeyBase64);
    }
  }

  /**
   * 處理收到的 Answer
   */
  private async handleAnswer(msg: MqttMessage): Promise<void> {
    const remotePublicKeyBase64 = msg.from;
    const answer = msg.payload as RTCSessionDescriptionInit;

    diagLog('[DIAG:WebRTC] Received answer from:', remotePublicKeyBase64.slice(0, 16));

    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) {
      devWarn(`[WebRTC] No pending connection for ${remotePublicKeyBase64.slice(0, 8)}...`);
      return;
    }

    // 檢查 signaling state - 只有在 have-local-offer 狀態才能接收 answer
    // 如果已經是 stable 狀態，表示連線已經建立或被其他 offer 取代
    if (peer.connection.signalingState !== 'have-local-offer') {
      devWarn(`[WebRTC] Ignoring answer - wrong signaling state: ${peer.connection.signalingState}`);
      return;
    }

    try {
      await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
      // remoteDescription 已 set → 補加先前因「還沒 set」而 buffer 的早到 candidate。
      // 這正是 14:16 卡死的修法:Windows(initiator)在 answer 到之前先收到 Mac 的 ICE,
      // 以前直接被丟、ICE 缺候選卡 checking;現在 buffer 到這裡才補加。
      await this.flushIncomingCandidates(remotePublicKeyBase64);
    } catch (error) {
      console.error('[WebRTC] Failed to set remote description:', error);
      this.closePeer(remotePublicKeyBase64);
    }
  }

  /**
   * 處理收到的 ICE Candidate
   */
  private async handleIceCandidate(msg: MqttMessage): Promise<void> {
    const remotePublicKeyBase64 = msg.from;
    const candidate = msg.payload as RTCIceCandidateInit;

    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) {
      // offer 還在等 inbound policy：先存起來，建 responder 時補上
      diagLog('[DIAG:WebRTC] ICE candidate before the peer exists, buffered:', remotePublicKeyBase64.slice(0, 16));
      this.bufferEarlyCandidate(remotePublicKeyBase64, candidate);
      return;
    }

    // remoteDescription 還沒 set → addIceCandidate 會 throw「remote description was null」
    // 而把 candidate 丟掉(這就是 14:16 失敗、14:43 成功的 race 根因)。改成先 buffer,
    // 等 setRemoteDescription(offer/answer) 後由 flushIncomingCandidates 補加。
    if (!peer.connection.remoteDescription) {
      peer.incomingCandidates.push(candidate);
      diagLog('[DIAG:WebRTC] ICE buffered (no remoteDescription yet):',
        remotePublicKeyBase64.slice(0, 12), `pending=${peer.incomingCandidates.length}`);
      return;
    }

    try {
      await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
      // candidate string format: "candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type> ..."
      const candStr = (candidate as RTCIceCandidateInit).candidate || '';
      const parts = candStr.split(' ');
      const protocol = parts[2] || '?';
      const ip = parts[4] || '?';
      const port = parts[5] || '?';
      const typIdx = parts.indexOf('typ');
      const type = typIdx >= 0 ? parts[typIdx + 1] : '?';
      diagLog('[DIAG:WebRTC] ICE add OK from', remotePublicKeyBase64.slice(0, 12),
        type + '/' + protocol, ip + ':' + port);
    } catch (error) {
      diagLog('[DIAG:WebRTC] ICE candidate FAILED:', (error as Error)?.message);
    }
  }

  /**
   * setRemoteDescription 之後呼叫:把先前因 remoteDescription 未就緒而 buffer 的
   * 早到 candidate 一次補加。清空 buffer，之後到的 candidate 走正常 addIceCandidate 路徑。
   */
  private async flushIncomingCandidates(remotePublicKeyBase64: string): Promise<void> {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || peer.incomingCandidates.length === 0) return;
    const buffered = peer.incomingCandidates;
    peer.incomingCandidates = [];
    diagLog('[DIAG:WebRTC] flushing buffered ICE:', String(buffered.length),
      'for', remotePublicKeyBase64.slice(0, 12));
    for (const cand of buffered) {
      try {
        await peer.connection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (error) {
        diagLog('[DIAG:WebRTC] buffered ICE add FAILED:', (error as Error)?.message);
      }
    }
  }

  /**
   * E2E 測試用：強制關閉指定 peer（或全部），模擬 DataChannel 中斷
   * - 呼叫 closePeer 內部方法做真實清理
   * - T27 測試用：驗證 p2pSend queue + 重連後 flush
   */
  public forceClosePeerForE2E(remotePublicKeyBase64?: string): number {
    if (remotePublicKeyBase64) {
      const existed = this.peers.has(remotePublicKeyBase64);
      if (existed) this.closePeer(remotePublicKeyBase64);
      return existed ? 1 : 0;
    }
    // 無參數 → 關閉所有
    const count = this.peers.size;
    const keys = Array.from(this.peers.keys());
    keys.forEach((k) => this.closePeer(k));
    return count;
  }

  /**
   * E2E 測試用：回傳指定 peer 的 DataChannel readyState
   * - 無 peer → 'none'
   * - peer 存在但無 dataChannel → 'no-channel'
   * - peer 存在且有 dataChannel → 'connecting' | 'open' | 'closing' | 'closed'
   */
  public getPeerStateForE2E(remotePublicKeyBase64: string): string {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return 'none';
    if (!peer.dataChannel) return 'no-channel';
    return peer.dataChannel.readyState;
  }

  /**
   * 關閉 Peer 連線
   */
  private closePeer(remotePublicKeyBase64: string): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer) {
      peer.dataChannel?.close();
      peer.connection.close();
      this.peers.delete(remotePublicKeyBase64);
      this.connectAttemptAt.delete(remotePublicKeyBase64);
      this.lastDcInboundAt.delete(remotePublicKeyBase64);
      // 心跳能力綁「本次連線」而非永久綁 pubkey：若對端 app 降版到不送心跳的舊版本（同一
      // pubkey、新連線），殘留的 hbCapable 會讓正常舊版在 35s 後被誤判成殭屍而反覆重建。
      // 拆連線即清 → 新連線由「真的收到心跳」重新贏得 hbCapable（收不到就退回舊 readyState 判定）。
      this.hbCapablePeers.delete(remotePublicKeyBase64);
      // e2e 模擬的「死傳輸」只屬於這條被拆掉的通道 → 重建後新通道不受影響（release 永遠空）
      this.simulatedDeadPeers.delete(remotePublicKeyBase64);
      this.updatePeerState(remotePublicKeyBase64, PeerConnectionState.CLOSED);
      devLog(`[WebRTC] Closed connection with ${remotePublicKeyBase64.slice(0, 8)}...`);
    }
    // 沒有 peer 了就停心跳 timer，避免登出後空轉（shutdown 也會清，這裡讓一般情況更即時）。
    if (this.peers.size === 0 && this.hbTimer) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  /**
   * 更新 Peer 連線狀態
   */
  private updatePeerState(remotePublicKeyBase64: string, state: PeerConnectionState): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer) {
      peer.connectionState = state;
    }
    this.stateListeners.forEach((callback) => callback(remotePublicKeyBase64, state));
  }

  /**
   * 更新資料通道狀態
   */
  private updateDataChannelState(remotePublicKeyBase64: string, state: DataChannelState): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (peer) {
      peer.dataChannelState = state;
    }
    this.dataChannelStateListeners.forEach((callback) => callback(remotePublicKeyBase64, state));
  }

  /**
   * 暫存 ICE Candidate 以便 IPv6 優先排序
   */
  private queueCandidate(remotePublicKeyBase64: string, candidate: RTCIceCandidate): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer) return;

    peer.pendingCandidates.push(candidate);

    // 清除舊的計時器
    if (peer.candidateFlushTimer) {
      clearTimeout(peer.candidateFlushTimer);
    }

    // 設定新的計時器，100ms 後發送（等待收集更多 candidates）
    peer.candidateFlushTimer = setTimeout(() => {
      this.flushCandidates(remotePublicKeyBase64);
    }, 100);
  }

  /**
   * 排序並發送所有暫存的 ICE Candidates
   * 優先順序：IPv6 host > IPv4 host > IPv6 srflx > IPv4 srflx > prflx
   */
  private flushCandidates(remotePublicKeyBase64: string): void {
    const peer = this.peers.get(remotePublicKeyBase64);
    if (!peer || peer.pendingCandidates.length === 0) return;

    // 清除計時器
    if (peer.candidateFlushTimer) {
      clearTimeout(peer.candidateFlushTimer);
      peer.candidateFlushTimer = null;
    }

    // 排序 candidates：IPv6 優先
    const sortedCandidates = [...peer.pendingCandidates].sort((a, b) => {
      const scoreA = this.getCandidatePriority(a);
      const scoreB = this.getCandidatePriority(b);
      return scoreB - scoreA; // 高分優先
    });

    // 記錄排序結果(diagLog 在 production 也保留 — 螢幕分享 ICE 診斷需要)
    diagLog(`[DIAG:WebRTC] ICE flush — sending ${sortedCandidates.length} candidates to`, remotePublicKeyBase64.slice(0, 12));
    sortedCandidates.forEach((c, i) => {
      const isIPv6 = c.address?.includes(':');
      diagLog(`  ${i + 1}. ${isIPv6 ? 'v6' : 'v4'} ${c.type}/${c.protocol} ${c.address}:${c.port}`);
    });

    // 按排序順序發送
    sortedCandidates.forEach((candidate) => {
      mqttService.sendIceCandidate(remotePublicKeyBase64, candidate);
    });

    // 清空暫存
    peer.pendingCandidates = [];
  }

  /**
   * 計算 ICE Candidate 優先分數
   * 分數越高越優先
   */
  private getCandidatePriority(candidate: RTCIceCandidate): number {
    let score = 0;
    const isIPv6 = candidate.address?.includes(':');
    const type = candidate.type;

    // IPv6 加 1000 分
    if (isIPv6) score += 1000;

    // 類型分數
    switch (type) {
      case 'host':  // 直連最優先
        score += 100;
        break;
      case 'srflx': // STUN 反射次之
        score += 50;
        break;
      case 'prflx': // Peer 反射
        score += 25;
        break;
      case 'relay': // TURN 中繼最低（已移除，但保留邏輯）
        score += 0;
        break;
    }

    return score;
  }

  /**
   * 映射 ICE 連線狀態
   */
  private mapIceConnectionState(state: RTCIceConnectionState): PeerConnectionState {
    switch (state) {
      case 'new':
        return PeerConnectionState.NEW;
      case 'checking':
        return PeerConnectionState.CONNECTING;
      case 'connected':
      case 'completed':
        return PeerConnectionState.CONNECTED;
      case 'disconnected':
        return PeerConnectionState.DISCONNECTED;
      case 'failed':
        return PeerConnectionState.FAILED;
      case 'closed':
        return PeerConnectionState.CLOSED;
      default:
        return PeerConnectionState.NEW;
    }
  }

  /**
   * 映射連線狀態
   */
  private mapConnectionState(state: RTCPeerConnectionState): PeerConnectionState {
    switch (state) {
      case 'new':
        return PeerConnectionState.NEW;
      case 'connecting':
        return PeerConnectionState.CONNECTING;
      case 'connected':
        return PeerConnectionState.CONNECTED;
      case 'disconnected':
        return PeerConnectionState.DISCONNECTED;
      case 'failed':
        return PeerConnectionState.FAILED;
      case 'closed':
        return PeerConnectionState.CLOSED;
      default:
        return PeerConnectionState.NEW;
    }
  }

  /**
   * 記錄連線類型（用於監控 P2P 連線品質）
   * - host: IPv4/IPv6 直連（最佳）
   * - srflx: STUN 反射（NAT 打洞）
   * - prflx: Peer 反射
   * - relay: TURN 中繼（最後手段）
   */
  private async logConnectionType(connection: RTCPeerConnection, peerKey: string): Promise<void> {
    try {
      const stats = await connection.getStats();
      let candidateType = 'unknown';
      let remoteCandidateType = 'unknown';
      let localAddress = '';
      let remoteAddress = '';
      let localProtocol = '?';
      let rtt: number | undefined;
      // 也列出所有 succeeded pairs(非 selected),看是否有更好的選項
      const allSucceededPairs: Array<{ local: string; remote: string; nominated: boolean }> = [];

      stats.forEach((report: any) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const localId = report.localCandidateId;
          const remoteId = report.remoteCandidateId;
          let lc: any = null;
          let rc: any = null;
          stats.forEach((c: any) => {
            if (c.id === localId) lc = c;
            if (c.id === remoteId) rc = c;
          });
          if (lc && rc) {
            allSucceededPairs.push({
              local: `${lc.candidateType}:${lc.address || lc.ip}:${lc.port}/${lc.protocol}`,
              remote: `${rc.candidateType}:${rc.address || rc.ip}:${rc.port}`,
              nominated: report.nominated === true || report.selected === true,
            });
          }
          // 若是 selected/nominated → 取為主回報
          if (report.nominated === true || report.selected === true) {
            if (lc) {
              candidateType = lc.candidateType || 'unknown';
              localAddress = `${lc.address || lc.ip}:${lc.port}`;
              localProtocol = lc.protocol || '?';
            }
            if (rc) {
              remoteCandidateType = rc.candidateType || 'unknown';
              remoteAddress = `${rc.address || rc.ip}:${rc.port}`;
            }
            rtt = report.currentRoundTripTime;
          }
        }
      });

      // 判斷是否為 IPv6
      const isIPv6 = localAddress.includes(':') && !localAddress.startsWith('[');
      const ipVersion = isIPv6 ? 'v6' : 'v4';

      diagLog(`[DIAG:WebRTC] selected pair ${peerKey.slice(0, 12)} | ` +
        `${candidateType}(${ipVersion})/${localProtocol} ${localAddress} ↔ ${remoteCandidateType} ${remoteAddress} ` +
        `rtt=${rtt ?? '?'}s`);
      if (allSucceededPairs.length > 1) {
        diagLog(`[DIAG:WebRTC] all succeeded pairs (${allSucceededPairs.length}):`);
        allSucceededPairs.forEach((p, i) => {
          diagLog(`  ${i + 1}.${p.nominated ? '★' : ' '} ${p.local} → ${p.remote}`);
        });
      }

      // 如果使用 TURN relay → 立即斷開（訊息內容不可經過伺服器）
      if (candidateType === 'relay') {
        console.error('[WebRTC] ❌ TURN relay detected — disconnecting (privacy violation)');
        this.disconnect(peerKey);
        return;
      }
    } catch (error) {
      console.error('[WebRTC] Failed to get connection stats:', error);
    }
  }
}

// 單例導出
export const webrtcService = new WebRTCService();

// e2e 用 seam：殭屍 DataChannel 的自癒路徑必須被實測（不能只靠推論）。release 不曝露。
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error debug seam
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error debug seam
  window.__aegisDebug.webrtc = {
    peers: () => webrtcService.peerPubkeys(),
    simulateDcDeath: (pk: string) => webrtcService.simulateDcDeath(pk),
    dcHealth: (pk: string) => webrtcService.dcHealthSnapshot(pk),
  };
}

export default webrtcService;
