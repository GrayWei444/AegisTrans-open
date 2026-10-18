/**
 * Peer Sync — 跨裝置訊息同步（純 P2P）
 *
 * 上層套 webrtcService（DataChannel）+ mqttService（presence 觸發 connect）。
 * 訊息流：
 *   發送：sendTextMessage(content) → 寫入本機 → broadcast 到所有 connected peers
 *   接收：webrtcService.onMessage → 解析 → addReceivedMessage 寫入本機（防重）→ 觸發 listeners
 *
 * 連線生命週期：
 *   initPeerSync(localPubkey, currentDeviceId, userId) — 啟動
 *   connectToPeers(peerPubkeys) — 對每個 peer 建立 P2P（idempotent）
 *   shutdownPeerSync() — 全部關掉
 */

import { mqttService } from './mqtt';
import { webrtcService } from './webrtc';
import { DataChannelState } from './webrtc';
import { peerHealthMonitor } from './peerHealthMonitor';
import {
  registerP2PFunctions,
  unregisterP2PFunctions,
  sendViaP2P,
  flushQueueForPeer,
  notifyConnectSuccess,
  loadOutbox,
  ackDelivered,
  sendAckToPeer,
  outboxRecipients,
  clearOutboxForPeer,
} from './p2pSend';
import { addMessage, addReceivedMessage, deleteMessage as deleteMessageStore, type Message } from './messageStore';
import { diagLog } from '../utils/diagLog';
import {
  initFileTransfer,
  shutdownFileTransfer,
  handleManifest,
  handleChunkFrame,
  onFileReceived,
  type FileManifestEnvelope,
} from './fileTransfer';
import {
  ENVELOPE_PROTOCOL_VERSION,
  buildEncryptedEnvelope,
  buildEncryptedEnvelopeOrGenerate,
  decryptEnvelope,
} from './groupKeyEnvelope';
import { devLog } from '../utils/devLog';
import { isAccountDevice, goneDeviceTracker } from './accountDevices';

let currentLocalPubkeyBase64: string | null = null;

type IncomingMessageListener = (msg: Message) => void;
type MessageDeletedListener = (messageId: string) => void;
type MissingGroupKeyRequester = (peerPubkey: string, keyId: string) => void;

let currentUserId: string | null = null;
let currentDeviceId: string | null = null;
let initialized = false;
let missingGroupKeyRequester: MissingGroupKeyRequester | null = null;
const incomingListeners = new Set<IncomingMessageListener>();
const messageDeletedListeners = new Set<MessageDeletedListener>();
let webrtcUnsubscribe: (() => void) | null = null;
let dataChannelStateUnsubscribe: (() => void) | null = null;
let presenceUnsubscribe: (() => void) | null = null;
const knownPeerPubkeys = new Set<string>();  // 追蹤要對誰廣播
const onlinePeers = new Set<string>();       // presence 認為 online 的 peers（peerHealthMonitor watchdog 用）
const inboundGates = new Map<string, Promise<void>>();  // 每個 peer 的入站帳號檢查串列（保序）
// 給已不在帳號清單上的裝置的 outbox：連續 24 小時、每次成功的清單都沒有它才清（對應 TofuTalk a08cc93、c0fe806；AegisTrans
//   審查 D：舊伺服器（660fdbb 之前）合併成一筆的裝置，公鑰不在任何一筆上，要等它下次開 App 才重新註冊——60 秒就刪會丟掉
//   給它的排隊訊息）。outbox 本身 30 天到期；斷線、不收入站照舊立刻做（pruneToAccountPeers、帳號檢查）。
const OUTBOX_GONE_SPAN_MS = 24 * 60 * 60 * 1000;
const outboxGoneTracker = () => goneDeviceTracker({ spanMs: OUTBOX_GONE_SPAN_MS });
let goneOutboxRecipients = outboxGoneTracker();

/**
 * peerHealthMonitor 用:卡住的 peer 重連。
 *
 * 🔑 根因修復(port AegisTalk reconnectPeer)：**絕不再無條件 disconnect**（=closePeer 拆 PC）。
 *   兩端 watchdog 各自 disconnect → PC 世代錯位 → channel 開了又關、永不收斂。改成只有 initiator 側
 *   (pubkey 較大)呼叫 connect()，由 connect() 內部決定「同一條 PC 原地重開 DataChannel」(PC 還活)
 *   還是「真死才 closePeer 重建」。非 initiator 側不動，等 initiator 的 (re-)offer。
 */
function reconnectStuckPeer(pk: string): void {
  const amInitiator = !!currentLocalPubkeyBase64 && currentLocalPubkeyBase64 > pk;
  // 🔑 殭屍例外(2026-07-14)：DataChannel 'open' 但心跳斷 = 這條傳輸已死。tiebreak 的用意是
  //   「別拆還活著的 PC」，但殭屍沒有東西可保護 —— 等待側若也只是等，單向死亡(只有我收不到,
  //   對端自認健康、不會重發 offer)就永遠沒人救。故殭屍時等待側也主動重建。
  //   不會 livelock：重建成功 → inbound 恢復 → 不再 stale → 觸發條件自己消失。
  if (amInitiator || webrtcService.isPeerZombie(pk)) {
    void webrtcService.connect(pk).catch((err) =>
      devLog('[PeerHealth] reconnect failed:', pk.slice(0, 8), err));
  } else {
    devLog('[PeerHealth] answerer waits for initiator (re-)offer:', pk.slice(0, 8));
  }
}

/** Debug introspection — 給 e2e test 偷看內部狀態。 */
export function __debugSnapshot(): {
  initialized: boolean;
  userId: string | null;
  currentDeviceId: string | null;
  webrtcInitialized: boolean;
  peers: Array<{
    pubkey: string;
    connState: string;
    iceState: string;
    dcState: string;
    isInitiator: boolean;
  }>;
} {
  // @ts-expect-error - 偷看 webrtcService 內部 peers Map
  const peers = webrtcService.peers as Map<string, {
    publicKeyBase64: string;
    connection: RTCPeerConnection;
    dataChannel: RTCDataChannel | null;
    isInitiator: boolean;
  }>;
  return {
    initialized,
    userId: currentUserId,
    currentDeviceId,
    // @ts-expect-error - 偷看 webrtc 是否初始化
    webrtcInitialized: !!webrtcService.localPublicKeyBase64,
    peers: Array.from(peers.entries()).map(([k, v]) => ({
      pubkey: k.slice(0, 12),
      connState: v.connection?.connectionState ?? 'n/a',
      iceState: v.connection?.iceConnectionState ?? 'n/a',
      dcState: v.dataChannel?.readyState ?? 'n/a',
      isInitiator: v.isInitiator,
    })),
  };
}

// 暴露給 e2e test（merge 不覆蓋）（CR-06/H-07：release build 不曝露內部 peer 狀態）
import { DEBUG_TOOLS } from '../utils/debugFlags';
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error
  window.__aegisDebug.peerSync = __debugSnapshot;
}

/** 啟動 peer sync。需在 mqttService.connect() 與 identity ready 後呼叫。 */
export function initPeerSync(opts: {
  localPubkeyBase64: string;
  currentDeviceId: string;
  userId: string;
  requestMissingGroupKey?: MissingGroupKeyRequester;
}): void {
  if (initialized && currentUserId === opts.userId && currentDeviceId === opts.currentDeviceId) {
    return; // 已就位
  }
  // 換帳號 / 換裝置 → 重新初始化
  if (initialized) {
    shutdownPeerSync();
  }
  currentUserId = opts.userId;
  currentDeviceId = opts.currentDeviceId;
  currentLocalPubkeyBase64 = opts.localPubkeyBase64;
  missingGroupKeyRequester = opts.requestMissingGroupKey ?? null;

  // 1) 初始化 webrtc service（會自動訂閱 MQTT 信令）
  webrtcService.initialize(opts.localPubkeyBase64);

  // 1.5) 只接受本帳號裝置的 offer（稽核 B1）
  webrtcService.setInboundPolicy(isAccountDevice);

  // 2) 監聽 DataChannel 訊息（string=控制 envelope；ArrayBuffer=檔案 chunk）
  //    先確認對方仍是本帳號裝置（被撤銷的不收、不回 ACK、不能要檔案，稽核 B1）；每個 peer 串成一列，檔案 chunk 才不會亂序
  webrtcUnsubscribe = webrtcService.onMessage((peerPubkey, data) => {
    const prev = inboundGates.get(peerPubkey) ?? Promise.resolve();
    const next = prev.then(() => isAccountDevice(peerPubkey)).then((ok) => {
      if (!ok) { devLog('[PeerSync] dropped data from a non-account device', peerPubkey.slice(0, 8)); return; }
      handleDataFrame(peerPubkey, data);
    }).catch((e) => console.error('[PeerSync] inbound gate failed:', e));
    inboundGates.set(peerPubkey, next);
    void next.finally(() => { if (inboundGates.get(peerPubkey) === next) inboundGates.delete(peerPubkey); });
  });
  function handleDataFrame(peerPubkey: string, data: string | ArrayBuffer): void {
    if (typeof data === 'string') {
      // delivery ACK 協定（review 2026-07-17）：發端每則訊息帶 plaintext `mid` 並留在 outbox，
      // 收端「durably 落盤」後回 {kind:'__ack',mid}，發端收到才刪 outbox。解決「send() 回 true 但
      // 死亡空窗內對端其實沒收到 → 訊息無聲蒸發」。ACK/心跳本身不進 outbox、不被 ACK（不會無限迴圈）。
      let mid: string | undefined;
      try {
        const env = JSON.parse(data) as { kind?: string; mid?: string };
        if (env.kind === '__ack') { if (env.mid) ackDelivered(env.mid); return; } // 收到 ACK → 刪 outbox
        mid = env.mid;
      } catch { /* 非 JSON → 交給 handleIncoming drop */ }
      void handleIncoming(peerPubkey, data).then((durable) => {
        if (durable && mid) sendAckToPeer(peerPubkey, mid); // 落盤成功才回 ACK
      }).catch((e) => console.error('[PeerSync] handleIncoming failed:', e));
    } else {
      // ArrayBuffer → 路由給 fileTransfer
      void handleChunkFrame(data, peerPubkey);
    }
  }

  // 3) DataChannel 開啟時 flush outbox queue（離線訊息送達關鍵）
  dataChannelStateUnsubscribe = webrtcService.onDataChannelStateChange((peerPubkey, state) => {
    if (state === DataChannelState.OPEN) {
      notifyConnectSuccess();
      void flushQueueForPeer(peerPubkey).then((flushed) => {
        if (flushed > 0) {
          devLog(`[PeerSync] Flushed ${flushed} queued messages to ${peerPubkey.slice(0, 8)}`);
        }
      });
    }
  });

  // 4) 註冊 p2pSend 需要的 webrtc 函式
  registerP2PFunctions({
    // isDataChannelOpen 同時驗 PC 還活著 → 不會把「PC 已 failed 但 readyState 殘留 open」誤判成已連線
    // 而把訊息送進黑洞（會改進 outbox 持久化）。
    isConnectedTo: (pk) => webrtcService.isDataChannelOpen(pk),
    sendToPeer: (pk, data) => webrtcService.send(pk, data),
    connectPeer: (pk) => webrtcService.connect(pk),
  });

  // 4.5) 啟動時把持久化 outbox 重新觸發投遞（跨 reload/重啟/crash「訊息絕不消失」）。
  //      內含 TTL 清理 + 舊 localStorage outbox 一次性搬遷。
  void loadOutbox();

  // 5) 監聽 MQTT presence：known peer 變上線
  //    - 沒有 peer → connect
  //    - peer 處於 failed/disconnected/closed → 清掉重連
  //    - peer 已連線 / 正在建立中 → 不打擾
  presenceUnsubscribe = mqttService.onPresenceChange((peerPubkey, isOnline) => {
    // 維護 online 集合給 peerHealthMonitor watchdog 判斷
    if (!isOnline) { onlinePeers.delete(peerPubkey); return; }
    onlinePeers.add(peerPubkey);
    if (!knownPeerPubkeys.has(peerPubkey)) return;

    // 🔑 根因修復(port AegisTalk 現行 presence handler)：
    //   1) 已連線且健康(isDataChannelOpen 同時驗 PC 還活著) → 不打擾。
    //   2) 否則**不 disconnect**(不拆 PC)。只有 initiator 側(pubkey 較大)呼叫 connect()，由 connect()
    //      內部決定「PC 活著就原地重開 DataChannel」還是「真死才 closePeer 重建」。小 pubkey 側不主動
    //      offer,等對方的 (re-)offer(Perfect Negotiation 會在同一條 PC 回 answer)。舊作法在這
    //      disconnect + 雙方都 connect → 雙重 offer 卡 ICE / PC 世代錯位、永不收斂。
    if (webrtcService.isDataChannelOpen(peerPubkey)) {
      return;
    }
    const willInitiate = !!currentLocalPubkeyBase64 && currentLocalPubkeyBase64 > peerPubkey;
    if (!willInitiate) {
      devLog(`[PeerSync] Friend ${peerPubkey.slice(0, 8)} online, answerer waits for initiator (re-)offer`);
      return;
    }
    void webrtcService.connect(peerPubkey).catch((err) =>
      devLog('[PeerSync] reconnect after presence failed:', err)
    );
  });

  // 5.5) 啟動 P2P watchdog — 定時(且只在 MQTT 確定連線的前提下)檢查每個 online peer
  //      的 DataChannel,沒 open 超過寬限期就重連。補掉「presence 重連只在上線邊緣觸發一次、
  //      卡 connecting 後永遠不自救」的洞。
  peerHealthMonitor.start({
    // watchdog 檢查對象 = presence 認為 online 的 known peers **∪ 連線已 failed 的 known peers**。
    //   後者是根因修復:connection 進入終端 'failed' 後 presence 常一起 stale 回報 offline
    //   → 光看 presence 這個 failed peer 永遠不進檢查清單 → 不會 reconnect(卡到對方剛好送 offer 才復原)。
    //   'failed' 是直接證據,據此納入檢查 → 過寬限期就 reconnectStuckPeer(仍走 initiator tiebreak,不風暴)。
    getOnlineKnownPeers: () =>
      [...knownPeerPubkeys].filter((pk) => onlinePeers.has(pk) || webrtcService.isPeerFailed(pk)),
    isPeerHealthy: (pk) => webrtcService.isPeerHealthy(pk),
    reconnectPeer: reconnectStuckPeer,
  });

  // 6) 初始化 fileTransfer + 訂閱「檔案進來/完成」事件 → 轉送給 useMessages
  initFileTransfer({
    userId: opts.userId,
    currentDeviceId: opts.currentDeviceId,
    ownPubkey: opts.localPubkeyBase64,
    sendChunk: (peer, frame) => webrtcService.send(peer, frame),
    sendJson: (peer, json) => { void sendViaP2P(peer, json); },
    getPeers: () => Array.from(knownPeerPubkeys),
    getBufferedAmount: (peer) => {
      // @ts-expect-error
      const p = webrtcService.peers?.get(peer);
      return p?.dataChannel?.bufferedAmount ?? 0;
    },
    isConnectedTo: (peer) => webrtcService.isDataChannelOpen(peer),
    connectPeer: (peer) => webrtcService.connect(peer),
  });
  onFileReceived((msg) => {
    incomingListeners.forEach((cb) => { try { cb(msg); } catch (e) { console.error(e); } });
  });

  // 定時重問缺的 group key → 第一次 request 掉包也能補回,buffer 的訊息不會卡死到 TTL 被丟。
  if (missingKeySweepTimer) clearInterval(missingKeySweepTimer);
  missingKeySweepTimer = setInterval(sweepMissingKeys, MISSING_KEY_SWEEP_INTERVAL_MS);

  initialized = true;
  devLog('[PeerSync] initialized for user', opts.userId.slice(0, 8), 'device', opts.currentDeviceId.slice(0, 8));
}

export function shutdownPeerSync(): void {
  peerHealthMonitor.stop();
  if (missingKeySweepTimer) { clearInterval(missingKeySweepTimer); missingKeySweepTimer = null; }
  if (webrtcUnsubscribe) { webrtcUnsubscribe(); webrtcUnsubscribe = null; }
  if (dataChannelStateUnsubscribe) { dataChannelStateUnsubscribe(); dataChannelStateUnsubscribe = null; }
  if (presenceUnsubscribe) { presenceUnsubscribe(); presenceUnsubscribe = null; }
  shutdownFileTransfer();
  unregisterP2PFunctions();
  knownPeerPubkeys.clear();
  onlinePeers.clear();
  inboundGates.clear();
  webrtcService.shutdown();
  incomingListeners.clear();
  currentUserId = null;
  currentDeviceId = null;
  currentLocalPubkeyBase64 = null;
  missingGroupKeyRequester = null;
  pendingByKeyId.clear();
  missingKeyRequestLastSent.clear();
  goneOutboxRecipients = outboxGoneTracker();
  initialized = false;
  devLog('[PeerSync] shutdown');
}

/** peerSync 是否已初始化（可安全送訊）。UI 用來判斷「登入後同步中」狀態。 */
export function isPeerSyncReady(): boolean {
  return initialized;
}

/** 對指定的 peer 發起 P2P 連線（idempotent），並登記為 broadcast 對象。
 * 防呆：如果 peer 是自己，直接 return — 避免 self-loop。
 */
export async function connectToPeer(peerPubkeyBase64: string): Promise<void> {
  if (!initialized) return;
  if (peerPubkeyBase64 === currentLocalPubkeyBase64) {
    console.error(`[PeerSync] Refusing to connect to self pubkey=${peerPubkeyBase64.slice(0, 16)}`);
    return;
  }
  knownPeerPubkeys.add(peerPubkeyBase64);
  try {
    await webrtcService.connect(peerPubkeyBase64);
  } catch (err) {
    devLog('[PeerSync] connect failed:', peerPubkeyBase64.slice(0, 8), err);
  }
}

/** 對多個 peers 一次發起 P2P，並登記為 broadcast 對象。
 * 防呆：自動排除自己的 pubkey（caller race 時可能不小心把自己 include 進來）。
 */
export async function connectToPeers(peerPubkeys: string[]): Promise<void> {
  const filtered = peerPubkeys.filter((pk) => pk !== currentLocalPubkeyBase64);
  if (filtered.length < peerPubkeys.length) {
    console.error(`[PeerSync] connectToPeers: filtered out self (was ${peerPubkeys.length}, now ${filtered.length})`);
  }
  filtered.forEach((pk) => knownPeerPubkeys.add(pk));
  await Promise.all(filtered.map((p) => connectToPeer(p)));
}

/** 對特定 peer 斷線（撤銷裝置時用）。 */
export function disconnectPeer(peerPubkeyBase64: string): void {
  if (!initialized) return;
  webrtcService.disconnect(peerPubkeyBase64);
}

/**
 * 帳號裝置清單更新時呼叫（稽核 B10）：不在清單上的 peer（被撤銷、重裝換了新 key）從廣播對象移除、
 * 斷線。以前 knownPeerPubkeys 從不刪：其他裝置一直對被撤的裝置廣播新訊息。outbox 不在這裡清
 * （見 observeAccountDeviceList；自己撤銷的那台由撤銷流程立刻清）。
 * 空清單不處理 —— 帳號至少有這台，空的代表沒抓到，不該把所有人踢掉。
 */
export function pruneToAccountPeers(accountPubkeys: string[]): string[] {
  if (!initialized || accountPubkeys.length === 0) return [];
  const keep = new Set(accountPubkeys);
  const removed = [...knownPeerPubkeys].filter((pk) => !keep.has(pk));
  for (const pk of removed) {
    knownPeerPubkeys.delete(pk);
    webrtcService.disconnect(pk);
  }
  if (removed.length) devLog('[PeerSync] pruned non-account peers:', removed.map((pk) => pk.slice(0, 8)).join(', '));
  return removed;
}

/**
 * 每次成功抓到帳號裝置清單都呼叫（auth.onDeviceListFetched）：排隊給「已不在清單上」的裝置（被撤銷、重裝換了新 key）
 * 的 outbox，要連續 24 小時、每次成功的清單都沒有它才清（稽核 B10；對應 TofuTalk a08cc93：以前一次快照就刪，
 * 清單偶發少一台時排隊中的訊息直接消失；對應 TofuTalk c0fe806，AegisTrans 審查 D：60 秒也太短）。空清單＝沒抓到，不算。
 * 回傳這次清掉的收件者。
 */
export async function observeAccountDeviceList(accountPubkeys: string[]): Promise<string[]> {
  if (!initialized || accountPubkeys.length === 0) return [];
  const tracker = goneOutboxRecipients;
  const recipients = await outboxRecipients();
  if (tracker !== goneOutboxRecipients) return [];   // 等待中 shutdown／換帳號了
  const gone = tracker.observe(accountPubkeys, recipients);
  for (const pk of gone) await clearOutboxForPeer(pk);
  if (gone.length) devLog('[PeerSync] cleared outbox for devices gone from the account:', gone.map((pk) => pk.slice(0, 8)).join(', '));
  return gone;
}

/**
 * 發送文字訊息：寫入本機 + 用 Group Key 加密整個 Message → 對每個 known peer 派發。
 * - peer 線上 → 直送
 * - peer 離線 → 進入 p2pSend 佇列；DataChannel open 時自動 flush
 *
 * Group key 沒有就現生一把（單裝置 bootstrap，跟 fileTransfer.sendFile 同 pattern）。
 * 永遠加密，絕不 fallback 到明文 envelope — application-layer E2EE 不可被靜默繞過。
 */
export async function sendTextMessage(content: string): Promise<Message> {
  if (!currentUserId || !currentDeviceId || !currentLocalPubkeyBase64) {
    throw new Error('[PeerSync] not initialized');
  }
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Empty message');

  diagLog(`[DIAG:send] start peers=${knownPeerPubkeys.size} content_len=${trimmed.length}`);

  // 1) 先寫本機（即時 UI 回饋）
  const msg = await addMessage(currentUserId, {
    type: 'text',
    content: trimmed,
    from_device_id: currentDeviceId,
  });

  // 2) 用 Group Key 加密（沒 key 就現生一把）— 失敗 throw，不靜默 fallback 明文
  let payload: string;
  try {
    payload = await buildEncryptedEnvelopeOrGenerate(
      currentUserId,
      currentLocalPubkeyBase64,
      'encrypted_text',
      msg,
      Array.from(knownPeerPubkeys),
    );
    diagLog(`[DIAG:send] envelope built, size=${payload.length}`);
  } catch (err) {
    diagLog(`[DIAG:send] FAILED encrypt: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  // 3) 對每個 known peer 透過 sendViaP2P（離線會 enqueue）
  for (const peerPubkey of knownPeerPubkeys) {
    const sent = await sendViaP2P(peerPubkey, payload);
    diagLog(`[DIAG:send] peer=${peerPubkey.slice(0, 16)} immediate=${sent}`);
  }

  return msg;
}

/** 註冊「收到 peer 訊息」listener；UI 用來即時更新訊息列表。 */
export function onIncomingMessage(cb: IncomingMessageListener): () => void {
  incomingListeners.add(cb);
  return () => { incomingListeners.delete(cb); };
}

/** 註冊「peer 刪了某 messageId」listener；UI 用來即時從畫面移除。 */
export function onMessageDeleted(cb: MessageDeletedListener): () => void {
  messageDeletedListeners.add(cb);
  return () => { messageDeletedListeners.delete(cb); };
}

/** Pull-model：B 點「下載」→ 對單一 sender peer 發 file_request envelope。 */
export async function sendFileRequest(targetPeer: string, fileId: string): Promise<void> {
  if (!currentUserId) return;
  const payload = await buildEncryptedEnvelope(currentUserId, 'encrypted_file_request', { fileId });
  if (!payload) return;
  void sendViaP2P(targetPeer, payload);
  devLog(`[PeerSync] FILE_REQUEST sent to ${targetPeer.slice(0, 8)} for ${fileId}`);
}

/** 跨裝置廣播刪訊息：對 knownPeerPubkeys 全部送一份 encrypted_delete envelope。
 *  抄 AegisTalk DELETE_MESSAGE pattern，但走 Group Key + WebRTC（離線會 enqueue）。 */
export async function sendDeleteMessage(messageId: string): Promise<void> {
  if (!currentUserId) return;
  if (knownPeerPubkeys.size === 0) {
    devLog('[PeerSync] sendDeleteMessage: no peers to notify');
    return;
  }
  const payload = await buildEncryptedEnvelope(currentUserId, 'encrypted_delete', { messageId });
  if (!payload) return;
  for (const peerPubkey of knownPeerPubkeys) {
    void sendViaP2P(peerPubkey, payload);
  }
}

/** 對所有 known peers 廣播檔案。 */
export { sendFile } from './fileTransfer';

// ===== 解不開的 encrypted_text 暫存（等 group key 到貨再 retry） =====
// 修「兩台剛上線、group key 還在路上（走 MQTT，比 WebRTC 慢）就傳第一則 → 收方解不開
// → 直接 DROP → 訊息掉了、要重登才通」的競態。
const PENDING_CAP = 100;
const PENDING_TTL_MS = 600_000; // 10 分鐘:給缺 key 的訊息足夠時間等 key 回來(配合定時 re-request)
const MISSING_KEY_REQUEST_COOLDOWN_MS = 30_000;
const MISSING_KEY_SWEEP_INTERVAL_MS = 25_000;
const pendingByKeyId = new Map<string, Array<{ peerPubkey: string; raw: string; ts: number }>>();
const missingKeyRequestLastSent = new Map<string, number>();
let missingKeySweepTimer: ReturnType<typeof setInterval> | null = null;

function requestMissingGroupKey(peerPubkey: string, keyId: string, now: number): void {
  if (!missingGroupKeyRequester) return;
  const requestKey = `${peerPubkey}\0${keyId}`;
  const last = missingKeyRequestLastSent.get(requestKey) ?? 0;
  if (now - last < MISSING_KEY_REQUEST_COOLDOWN_MS) return;
  missingKeyRequestLastSent.set(requestKey, now);
  try {
    missingGroupKeyRequester(peerPubkey, keyId);
    diagLog(`[DIAG:recv] REQUEST group-key keyId=${keyId.slice(0, 12)} from=${peerPubkey.slice(0, 16)}`);
  } catch (err) {
    diagLog(`[DIAG:recv] REQUEST group-key failed keyId=${keyId.slice(0, 12)} err=${(err as Error)?.message || String(err)}`);
  }
}

function bufferUndecryptable(peerPubkey: string, raw: string, keyId?: string): void {
  if (!keyId) {
    diagLog('[DIAG:recv] DROP decrypt-failed (no keyId)');
    return;
  }
  // TTL 清理 + 全域上限（避免 OOM / 被灌爆）
  const now = Date.now();
  let total = 0;
  for (const [k, list] of pendingByKeyId) {
    const kept = list.filter((e) => now - e.ts < PENDING_TTL_MS);
    if (kept.length) pendingByKeyId.set(k, kept); else pendingByKeyId.delete(k);
    total += kept.length;
  }
  if (total >= PENDING_CAP) {
    diagLog('[DIAG:recv] DROP decrypt-failed (pending buffer full)');
    return;
  }
  const list = pendingByKeyId.get(keyId) ?? [];
  list.push({ peerPubkey, raw, ts: now });
  pendingByKeyId.set(keyId, list);
  diagLog(`[DIAG:recv] BUFFERED decrypt-failed keyId=${keyId.slice(0, 12)} (await group key, ${list.length} pending)`);
  requestMissingGroupKey(peerPubkey, keyId, now);
}

/**
 * group key（keyId）到貨後呼叫：把之前因沒這把 key 而 buffer 的訊息重新處理。
 * 由 App.tsx 在 handleKeyDistribution 之後呼叫 → 第一則訊息自動補上，不用重登。
 */
export async function retryPendingForKey(keyId: string): Promise<void> {
  const list = pendingByKeyId.get(keyId);
  if (!list || list.length === 0) return;
  pendingByKeyId.delete(keyId);
  diagLog(`[DIAG:recv] RETRY ${list.length} buffered msg(s) for keyId=${keyId.slice(0, 12)}`);
  for (const { peerPubkey, raw } of list) {
    try {
      // review #2(c)：buffered 訊息補到 group key 後落盤成功，也必須回 ACK（鏡像 onMessage 的落盤→ACK）。
      // 舊碼丟掉 handleIncoming 的 durable 結果 → 發端收不到 ACK → 白白等下次重連重送。
      let mid: string | undefined;
      try { mid = (JSON.parse(raw) as { mid?: string }).mid; } catch { /* 非 JSON → 無 mid */ }
      const durable = await handleIncoming(peerPubkey, raw);
      if (durable && mid) sendAckToPeer(peerPubkey, mid);
    } catch (e) { console.error('[PeerSync] retry buffered failed:', e); }
  }
}

/**
 * 定時重問缺的 group key:第一次 request 可能因 MQTT 抖動掉包 → 只靠「新訊息才 request」不夠。
 * 每 tick 對 buffer 裡每個 keyId 的來源 peer 重發 request(requestMissingGroupKey 內含 30s cooldown 防洗)。
 * 配合拉長的 PENDING_TTL_MS → 缺 key 的訊息不會卡死到被丟,直到 key 回來 retry 解開。
 */
function sweepMissingKeys(): void {
  if (pendingByKeyId.size === 0) return;
  const now = Date.now();
  for (const [keyId, list] of pendingByKeyId) {
    const peers = new Set(list.map((e) => e.peerPubkey));
    for (const peer of peers) requestMissingGroupKey(peer, keyId, now);
  }
}

/**
 * 回傳 true = 訊息已「durably 收到並落盤」→ 可回 delivery ACK 讓發端刪 outbox。
 * 回傳 false = 未落盤（解不開先 buffer / drop / 自己的訊息 / 錯誤）→ 不 ACK，讓發端重送（至少一次投遞）。
 */
async function handleIncoming(peerPubkey: string, raw: string): Promise<boolean> {
  diagLog(`[DIAG:recv] from=${peerPubkey.slice(0, 16)} bytes=${raw.length}`);
  if (!currentUserId) {
    diagLog('[DIAG:recv] DROP no currentUserId');
    return false;
  }
  let envelope: { v: number; kind: string; keyId?: string; ciphertext?: string; iv?: string };
  try {
    envelope = JSON.parse(raw);
  } catch {
    diagLog(`[DIAG:recv] DROP invalid JSON from ${peerPubkey.slice(0, 8)}`);
    return false;
  }
  if (envelope.v !== ENVELOPE_PROTOCOL_VERSION) {
    diagLog(`[DIAG:recv] DROP unsupported protocol v=${envelope.v}`);
    return false;
  }
  diagLog(`[DIAG:recv] envelope kind=${envelope.kind}`);

  // ====== Encrypted file manifest ======
  if (envelope.kind === 'encrypted_file_manifest') {
    const inner = await decryptEnvelope<FileManifestEnvelope>(envelope);
    if (!inner) { bufferUndecryptable(peerPubkey, raw, envelope.keyId); return false; }
    if (inner.kind !== 'file_manifest' || !inner.msg) {
      devLog('[PeerSync] Decrypted manifest invalid:', inner.kind);
      return false;
    }
    await handleManifest(inner, peerPubkey);
    return true;
  }

  // ====== Encrypted text message (Group Key, AES-256-GCM) ======
  if (envelope.kind === 'encrypted_text') {
    const msg = await decryptEnvelope<Message>(envelope);
    if (!msg) {
      // 解不開 = 還沒收到對方的 group key(keyId)。不要丟 → buffer，等該 group key
      // 到貨（App.tsx handleKeyDistribution → retryPendingForKey）再 retry。**不 ACK**（buffer 非落盤）。
      bufferUndecryptable(peerPubkey, raw, envelope.keyId);
      return false;
    }
    if (msg.from_device_id === currentDeviceId) {
      diagLog(`[DIAG:recv] DROP own-msg from_device_id=${msg.from_device_id?.slice(0, 8)} == currentDeviceId`);
      return false;
    }
    const result = await addReceivedMessage(currentUserId, msg);
    if (!result.inserted) {
      // 已存在（重送去重）→ 仍算 durably 收到 → ACK，讓發端刪 outbox 停止重送。
      diagLog(`[DIAG:recv] dedupe (already have) msg_id=${msg.id?.slice(0, 8)} — still ACK`);
      return true;
    }
    diagLog(`[DIAG:recv] OK rendering msg_id=${msg.id?.slice(0, 8)} from=${msg.from_device_id?.slice(0, 8)} content_len=${msg.content?.length || 0} listeners=${incomingListeners.size}`);
    incomingListeners.forEach((cb) => {
      try { cb(result.message); } catch (e) { console.error(e); }
    });
    return true;
  }

  // ====== Encrypted file request（pull-model：B 點下載 → A 開始送 chunks） ======
  if (envelope.kind === 'encrypted_file_request') {
    const inner = await decryptEnvelope<{ fileId?: string }>(envelope);
    if (!inner) { bufferUndecryptable(peerPubkey, raw, envelope.keyId); return false; } // 解不開→buffer
    if (!inner.fileId) return false; // 解開但 malformed → drop（不 ACK、不 buffer）
    const { handleFileRequest } = await import('./fileTransfer');
    await handleFileRequest(inner.fileId, peerPubkey);
    devLog(`[PeerSync] FILE_REQUEST received from ${peerPubkey.slice(0, 8)} for ${inner.fileId}`);
    return true;
  }

  // ====== Encrypted delete-message tombstone（跨裝置同步刪） ======
  if (envelope.kind === 'encrypted_delete') {
    const inner = await decryptEnvelope<{ messageId?: string }>(envelope);
    if (!inner) { bufferUndecryptable(peerPubkey, raw, envelope.keyId); return false; } // 解不開→buffer
    if (!inner.messageId) return false; // 解開但 malformed → drop
    await deleteMessageStore(currentUserId, inner.messageId);
    messageDeletedListeners.forEach((cb) => {
      try { cb(inner.messageId!); } catch (e) { console.error(e); }
    });
    devLog('[PeerSync] Remote delete applied:', inner.messageId);
    return true;
  }

  // 過去支援的 plaintext { kind: 'text' } / { kind: 'file_manifest' } envelope 已下線
  // ——sender 永遠加密（必要時 ensureMyDevicesGroupKey 現生 key），收到 plaintext envelope
  // 只可能是 legacy build 或攻擊者偽造，一律 drop。
  devLog('[PeerSync] Unknown / rejected envelope kind:', envelope.kind);
  return false;
}

// 防止 mqttService 未使用警告（型別偵測）
void mqttService;
