/**
 * P2P Send Service — ADR-016 統一 P2P 訊息發送 + 持久化 outbox
 *
 * 架構：MQTT 純信令，P2P DataChannel 負責所有訊息內容（無 MQTT fallback）
 * - P2P 已連線 → 直接發送
 * - P2P 未連線 → 寫入持久化 outbox（SQLite）+ connectPeer（MQTT 僅信令建 WebRTC）
 * - P2P 連線建立 → flush outbox（只走 DataChannel）
 * - 啟動 → loadOutbox 重新觸發投遞（跨 reload/重啟/crash「訊息絕不消失」）
 * - 背壓機制 → ICE 連續失敗暫停建連
 *
 * ⚠️ 死罪修正（LEARNINGS_FROM_AEGISTALK §1 / AegisTalk HANDOFF §0.29）：舊版 outbox 是
 * localStorage + in-memory Map → reload / 隱私模式清資料 / quota 爆即丟訊息，且沒有啟動重投。
 * 改用 SQLite `pending_messages`（database.ts）作唯一真相來源 + loadOutbox()。
 * 佇列僅在「P2P 未連線」時用 → 連線需數百 ms~數秒、遠長於 SQLite 寫入，
 * 故 onDataChannelOpen→flush 時持久化必已完成。
 */

import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import {
  addPendingMessage,
  getPendingMessagesForRecipient,
  getAllPendingMessages,
  removePendingMessage,
  updatePendingMessageRetry,
  getPendingMessageCount,
  getPendingMessageStats,
  deletePendingMessagesForRecipient,
  cleanupOldPendingMessages,
  getPendingRecipients,
} from './database';
import { DC_MAX_MESSAGE_CHARS } from './dcFraming';

// ============================================
// P2P 函式註冊（由 AppProvider/peerSync 注入）
// ============================================

type IsConnectedFn = (remotePublicKey: string) => boolean;
type SendToPeerFn = (remotePublicKey: string, data: string) => boolean;
type ConnectPeerFn = (remotePublicKey: string) => Promise<void>;

let _isConnectedTo: IsConnectedFn | null = null;
let _sendToPeer: SendToPeerFn | null = null;
let _connectPeer: ConnectPeerFn | null = null;

export function registerP2PFunctions(fns: {
  isConnectedTo: IsConnectedFn;
  sendToPeer: SendToPeerFn;
  connectPeer: ConnectPeerFn;
}): void {
  _isConnectedTo = fns.isConnectedTo;
  _sendToPeer = fns.sendToPeer;
  _connectPeer = fns.connectPeer;
  devLog('[p2pSend] P2P functions registered');
}

export function unregisterP2PFunctions(): void {
  _isConnectedTo = null;
  _sendToPeer = null;
  _connectPeer = null;
}

// ============================================
// 離線 outbox（SQLite 持久化 — 跨 reload/重啟/crash 不丟）
// ============================================

// 每人 outbox 安全上限（防失控）。達上限「不靜默丟新訊息」（§0.29 死罪原則）：
// 改 console.error 警示 + 仍寫入，靠 30 天 TTL（cleanupOldPendingMessages）清最舊。
const MAX_QUEUE_PER_RECIPIENT = 500;
const LEGACY_STORAGE_KEY = 'aegistrans_p2p_outbox';

function newPendingId(): string {
  try {
    return `p2p_${crypto.randomUUID()}`;
  } catch {
    return `p2p_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  }
}

/** 從 P2P envelope JSON 取 type 作 messageType（best-effort，純標註用） */
function envelopeType(payload: string): string {
  try {
    const t = (JSON.parse(payload) as { type?: string })?.type;
    return typeof t === 'string' ? t : 'p2p';
  } catch {
    return 'p2p';
  }
}

// ============================================
// 背壓機制（ADR-016: 連續建連失敗暫停）
// ============================================

let _consecutiveConnectFailures = 0;
let _backpressureUntil = 0;
const BACKPRESSURE_MAX_FAILURES = 3;
const BACKPRESSURE_PAUSE_MS = 10_000; // 10 秒

function isBackpressured(): boolean {
  return Date.now() < _backpressureUntil;
}

function recordConnectFailure(): void {
  _consecutiveConnectFailures++;
  if (_consecutiveConnectFailures >= BACKPRESSURE_MAX_FAILURES) {
    _backpressureUntil = Date.now() + BACKPRESSURE_PAUSE_MS;
    devLog(`[p2pSend] Backpressure: ${_consecutiveConnectFailures} consecutive failures, pausing ${BACKPRESSURE_PAUSE_MS}ms`);
  }
}

function recordConnectSuccess(): void {
  _consecutiveConnectFailures = 0;
  _backpressureUntil = 0;
}

/** 記錄建連成功（供 peerSync 呼叫） */
export function notifyConnectSuccess(): void {
  recordConnectSuccess();
}

// delivery ACK：收到對端 ACK 的 mid 集合（in-memory，只為擋「ACK 早於 enqueue 落盤」的競態）。
const _ackedMids = new Set<string>();

/**
 * 寫入持久化 outbox（async；呼叫者同步路徑以 `void enqueue(...)` 觸發、不阻塞）。
 * delivery ACK 模型：每則訊息一律先寫 outbox（不論是否立即送出），收到對端 ACK 才刪（見 ackDelivered）。
 * id = envelope 的 mid（唯一），ACK 帶同一 mid 回來即可精準刪。
 */
async function enqueue(recipientPubkey: string, payload: string, id: string): Promise<void> {
  // 競態①：ACK 在 enqueue 前就到 → 不必寫（訊息已確認送達）。
  if (_ackedMids.has(id)) { _ackedMids.delete(id); return; }
  try {
    const count = await getPendingMessageCount(recipientPubkey);
    if (count >= MAX_QUEUE_PER_RECIPIENT) {
      // 不靜默丟新訊息（§0.29）：警示 + 仍寫入，靠 TTL 清最舊。
      console.error(`[p2pSend] Outbox for ${recipientPubkey.slice(0, 16)} at ${count} (>= ${MAX_QUEUE_PER_RECIPIENT}) — still persisting; TTL reaps oldest`);
    }
    await addPendingMessage({
      id,
      recipientPubkey,
      encryptedPayload: payload,
      messageType: envelopeType(payload),
      createdAt: Date.now(),
    });
    // 競態②：ACK 在 enqueue 進行中到達 → 寫完立刻刪。
    if (_ackedMids.has(id)) { _ackedMids.delete(id); await removePendingMessage(id).catch(() => {}); }
    diagLog(`[DIAG:P2P:OUTBOX] persisted for ${recipientPubkey.slice(0, 16)} mid=${id.slice(0, 12)} (count=${count + 1})`);
  } catch (err) {
    console.error('[p2pSend] Failed to persist outbox message:', (err as Error)?.message || String(err));
  }
}

/** 把 mid 注入 envelope JSON（delivery ACK 用；收端會回傳同一 mid）。 */
function injectMid(payload: string, mid: string): string {
  try {
    const obj = JSON.parse(payload) as Record<string, unknown>;
    obj.mid = mid;
    return JSON.stringify(obj);
  } catch {
    return payload; // 非 JSON（不該發生）→ 原樣，不追蹤
  }
}

/** 收到對端 delivery ACK：從 outbox 刪掉該 mid（真正送達確認，非 send()===true）。 */
export function ackDelivered(mid: string): void {
  _ackedMids.add(mid);
  void removePendingMessage(mid).catch(() => {});
  if (_ackedMids.size > 2000) _ackedMids.clear(); // race-guard set 短命，防無限漲
}

/** 回一個 delivery ACK 給對端（收端落盤後呼叫）。直接送、不進 outbox、不被 ACK（避免無限迴圈）。 */
export function sendAckToPeer(recipientPubkey: string, mid: string): void {
  if (!_sendToPeer) return;
  try {
    _sendToPeer(recipientPubkey, JSON.stringify({ kind: '__ack', mid }));
  } catch { /* ACK best-effort：送不出去 → 發端會重送、收端會重 ACK */ }
}

/**
 * P2P 連線建立時呼叫：flush 該 peer 在持久化 outbox 裡的所有待送訊息。
 * 內容只走 P2P DataChannel；送成功才從 SQLite 刪除（at-least-once，收端依 message id dedup）。
 * 保序：某筆送失敗（DataChannel 尚未 OPEN）→ 停在該筆，其後保留待下次 flush。
 */
export async function flushQueueForPeer(recipientPubkey: string): Promise<number> {
  if (!_sendToPeer) {
    diagLog(`[DIAG:P2P:FLUSH] Skipped for ${recipientPubkey.slice(0, 16)}: _sendToPeer not registered`);
    return 0;
  }

  let pending;
  try {
    pending = await getPendingMessagesForRecipient(recipientPubkey);
  } catch (err) {
    console.error('[p2pSend] Failed to read outbox:', (err as Error)?.message || String(err));
    return 0;
  }
  if (pending.length === 0) {
    diagLog(`[DIAG:P2P:FLUSH] Empty outbox for ${recipientPubkey.slice(0, 16)}`);
    return 0;
  }

  let sentCount = 0;
  for (const msg of pending) {
    // 永遠送不出去的超大條目（傳輸統一 X5）：以前每次 flush 都停在這筆 → 該裝置之後的訊息全部卡住 30 天
    if (msg.encryptedPayload.length > DC_MAX_MESSAGE_CHARS) {
      console.error('[p2pSend] outbox entry can never fit a DataChannel message — removing so it stops blocking',
        msg.id.slice(0, 20), msg.encryptedPayload.length);
      await removePendingMessage(msg.id).catch(() => {});
      continue;
    }
    let sent = false;
    try {
      sent = _sendToPeer(recipientPubkey, msg.encryptedPayload);
    } catch (err) {
      devWarn('[p2pSend] Error sending outbox message:', err);
    }
    if (!sent) {
      // DataChannel 尚未 OPEN → 保留此筆與其後（維持順序），記一次重試後等下次 flush
      await updatePendingMessageRetry(msg.id).catch(() => {});
      break;
    }
    // delivery ACK：送出後「不刪」outbox，等對端回 ACK 才刪（見 ackDelivered）。重連時會重送、
    // 收端依 content message id dedup（不會重複顯示）→ 至少一次投遞 + 最終確認。
    sentCount++;
  }

  if (sentCount > 0) {
    diagLog(`[DIAG:P2P:FLUSH] Sent ${sentCount}/${pending.length} outbox messages to ${recipientPubkey.slice(0, 16)}`);
  } else {
    diagLog(`[DIAG:P2P:FLUSH] Called for ${recipientPubkey.slice(0, 16)} but 0/${pending.length} sent (DataChannel not ready?)`);
  }
  return sentCount;
}

// ============================================
// 主要 API
// ============================================

/**
 * 透過 P2P DataChannel 發送訊息
 *
 * @param recipientPubkey - 接收者公鑰 (base64)
 * @param payload - P2P envelope JSON（已包含 type + payload）
 * @returns true = 已立即發送，false = 已加入 outbox（等待 P2P 連線）；
 *   超過 DataChannel 單則上限（dcFraming.DC_MAX_MESSAGE_CHARS）的訊息永遠送不出去 → 不入 outbox，回 false
 */
export async function sendViaP2P(
  recipientPubkey: string,
  payload: string,
): Promise<boolean> {
  // delivery ACK：每則訊息帶唯一 mid、一律先寫 outbox（不論是否立即送出）。send()===true 只代表進本機
  // SCTP buffer，不代表對端收到 → 舊版「送成功就不入 outbox」在死亡空窗會漏訊息。改成收到對端 ACK 才刪。
  // persist-before-send（review #1）：**await 落盤完成再送 DataChannel**。若在寫入 SQLite 前 App 被凍結/
  // 殺掉且訊息尚未送達，重啟後 outbox 才有這則可重送 —— 這才是真正的「訊息絕不消失」。舊版 `void enqueue`
  // 是 fire-and-forget，send 早於落盤 → 空窗被殺就丟。
  const mid = newPendingId();
  const tracked = injectMid(payload, mid);
  // 永遠送不出去的超大訊息不入 outbox（傳輸統一 X5），否則會擋住該裝置之後的所有訊息
  if (tracked.length > DC_MAX_MESSAGE_CHARS) {
    console.error('[p2pSend] message too large for P2P, not queued:', tracked.length, 'chars');
    return false;
  }
  await enqueue(recipientPubkey, tracked, mid);

  if (!_isConnectedTo || !_sendToPeer || !_connectPeer) {
    devWarn('[p2pSend] P2P functions not registered yet — kept in outbox');
    return false;
  }

  // 嘗試直接發送（成功也不刪 outbox，等 ACK）
  if (_isConnectedTo(recipientPubkey)) {
    let sent = false;
    try { sent = _sendToPeer(recipientPubkey, tracked); } catch { /* fall through to connect */ }
    if (sent) {
      diagLog('[DIAG:SEND] P2P sent (awaiting ack) to:', recipientPubkey.slice(0, 16));
      return true;
    }
    devLog('[p2pSend] P2P send failed despite isConnectedTo=true — will retry from outbox');
  }

  // P2P 未連線或發送失敗 → outbox 已有，建立 P2P，DataChannel open 後 flush 重送
  diagLog('[DIAG:SEND] No P2P / send failed, kept in outbox for:', recipientPubkey.slice(0, 16));

  // ADR-016 背壓：連續失敗時暫停建連
  if (isBackpressured()) {
    devLog('[p2pSend] Backpressured, skipping connectPeer');
    return false;
  }

  _connectPeer(recipientPubkey).catch((err) => {
    recordConnectFailure();
    diagLog('[DIAG:SEND] connectPeer failed:', (err as Error)?.message || String(err));
  });

  return false;
}

/**
 * 一次性把舊版 localStorage outbox（aegistrans_p2p_outbox）搬進 SQLite，搬完清掉。
 * 升級到 SQLite outbox 的當下，舊裝置上排隊中的訊息不能因為換 backend 就消失（這正是本次
 * 修正要保證的「訊息絕不消失」）。best-effort：失敗不擋啟動。
 */
async function migrateLegacyLocalStorageOutbox(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return; // localStorage 不可用（隱私模式等）
  }
  if (!raw) return;
  try {
    const data = JSON.parse(raw) as Record<string, Array<{ payload?: string; queuedAt?: number }>>;
    let migrated = 0;
    for (const [peer, msgs] of Object.entries(data)) {
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (!m?.payload) continue;
        // review #2(a)：舊 localStorage outbox 的 payload 沒有 mid → 收端無從回 ACK → 這些 row 永遠不刪、
        // 每次重連重送。用 row id 當 mid 注入 envelope，收端就能 echo mid 回 ACK → 正常清除。
        const mid = newPendingId();
        await addPendingMessage({
          id: mid,
          recipientPubkey: peer,
          encryptedPayload: injectMid(m.payload, mid),
          messageType: envelopeType(m.payload),
          createdAt: typeof m.queuedAt === 'number' ? m.queuedAt : Date.now(),
        });
        migrated++;
      }
    }
    if (migrated > 0) console.error(`[p2pSend] Migrated ${migrated} legacy localStorage outbox message(s) → SQLite`);
  } catch (err) {
    console.error('[p2pSend] legacy outbox migration failed:', (err as Error)?.message || String(err));
  }
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch { /* ignore */ }
}

/**
 * 啟動時呼叫：清過期 → 搬舊 localStorage → 把持久化 outbox 裡仍待送的訊息重新觸發投遞
 * （對每個有待送的 peer connectPeer，連上後 DataChannel open → flushQueueForPeer 自動送出）。
 * 這是跨 reload/重啟/crash「訊息絕不消失」的關鍵。
 * （連不上也無妨：presence 翻 online 時 peerSync 仍會 connectPeer，flush 一律從 SQLite 讀。）
 */
export async function loadOutbox(): Promise<void> {
  if (!_connectPeer) {
    devWarn('[p2pSend] loadOutbox: P2P functions not registered yet');
    return;
  }
  await cleanupOldPendingMessages().catch((err) =>
    console.error('[p2pSend] cleanupOldPendingMessages failed:', (err as Error)?.message || String(err)));
  await migrateLegacyLocalStorageOutbox();

  let all;
  try {
    all = await getAllPendingMessages();
  } catch (err) {
    console.error('[p2pSend] loadOutbox failed to read:', (err as Error)?.message || String(err));
    return;
  }
  const recipients = [...new Set(all.map((m) => m.recipientPubkey))];
  if (recipients.length === 0) return;
  console.error(`[p2pSend] loadOutbox: ${all.length} pending across ${recipients.length} peer(s) → reconnecting`);
  for (const pk of recipients) {
    if (isBackpressured()) break;
    _connectPeer(pk).catch((err) => {
      recordConnectFailure();
      diagLog('[DIAG:OUTBOX] loadOutbox connectPeer failed:', (err as Error)?.message || String(err));
    });
  }
}

/** 取得當前 outbox 統計（給 UI 顯示「N 則訊息等待傳送」用）*/
export async function getOutboxStats(): Promise<{ totalMessages: number; peersAwaiting: number }> {
  try {
    return await getPendingMessageStats();
  } catch {
    return { totalMessages: 0, peersAwaiting: 0 };
  }
}

/**
 * 清掉某個 peer 的所有 outbox 訊息 — 撤銷裝置後呼叫，避免「待傳給已撤銷
 * 裝置的訊息卡 30 天」。冷消息對撤銷的裝置毫無意義。回傳刪除筆數。
 */
export async function clearOutboxForPeer(peerPubkey: string): Promise<number> {
  try {
    const removed = await deletePendingMessagesForRecipient(peerPubkey);
    if (removed > 0) devLog(`[p2pSend] Cleared ${removed} queued messages for revoked peer ${peerPubkey.slice(0, 16)}`);
    return removed;
  } catch (err) {
    console.error('[p2pSend] clearOutboxForPeer failed:', (err as Error)?.message || String(err));
    return 0;
  }
}

/**
 * outbox 裡有排隊訊息的收件者（不重複）。peerSync 用來找「已不在帳號裝置清單上」的收件者（被撤銷、重裝換了新 key，
 * 稽核 B10）：連續 24 小時、每次成功的清單都沒有它才 clearOutboxForPeer（對應 TofuTalk a08cc93、c0fe806；AegisTrans
 * 審查 D）。讀不到回空陣列（這輪不清）。
 */
export async function outboxRecipients(): Promise<string[]> {
  try {
    return await getPendingRecipients();   // SELECT DISTINCT，不把每則加密內容讀出來（AegisTrans 審查 E）
  } catch (err) {
    console.error('[p2pSend] outboxRecipients failed to read:', (err as Error)?.message || String(err));
    return [];
  }
}

/**
 * 取得某 peer 的 outbox 待送數量（診斷用）
 */
export async function getQueueSize(recipientPubkey: string): Promise<number> {
  try {
    return await getPendingMessageCount(recipientPubkey);
  } catch {
    return 0;
  }
}
