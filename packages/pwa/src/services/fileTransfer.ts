/**
 * File Transfer — 大檔分塊跨裝置傳輸
 *
 * 協定（純 P2P，走 WebRTC DataChannel）：
 *   1. Sender 計算 sha256 + 切 chunks（64KB 一塊）
 *   2. Sender 對每個 peer 送 file_manifest（JSON 字串，含 fileData 完整 metadata）
 *   3. Sender 對每個 peer 逐塊送 binary chunk（ArrayBuffer，前 N bytes 為 header）
 *   4. Receiver 收齊所有 chunks → 驗 sha256 → 組 Blob → 寫入 message store
 *
 * Binary chunk frame:
 *   [uint32 LE: header length N]
 *   [N bytes: UTF-8 JSON header {fileId, chunkIndex}]
 *   [後續 bytes: chunk binary data]
 */

import { addMessage, addReceivedMessage, updateMessage, findMessageByFileId, type Message, type FileMeta } from './messageStore';
import * as groupKeyService from './groupKey';
import { myDevicesGroupId } from './myDevicesGroup';
import { buildEncryptedEnvelopeOrGenerate, ENVELOPE_PROTOCOL_VERSION } from './groupKeyEnvelope';
import { createSHA256, type IHasher } from 'hash-wasm';
import { checkUploadQuota, checkSingleFileSize } from './tierGate';
import { getNativeFileStream } from './nativeFileStream';
import { useSubscriptionStore } from '../stores/subscriptionStore';
import { devLog } from '../utils/devLog';

const PROTOCOL_VERSION = ENVELOPE_PROTOCOL_VERSION;
// 安全 chunk size: 多數瀏覽器 DataChannel max message ~256KB，留 header overhead
const CHUNK_SIZE = 64 * 1024;          // 64 KB
// IDB 路徑上限 2GB（單一 Chrome Blob/IDB ~2GB 硬邊界）。超過此值走 native
// stream-to-disk（目前僅 Electron；web/PWA 永遠卡在這裡 — 產品決策）。
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

// ============================================================
// >2GB stream-to-disk（HANDOFF 步驟 1/2 + iOS/Android 階段 (a)）
// 收檔：chunk 解密後直接 random-access 落盤（不進 chunkBlobs/IDB）。
// 送檔：>2GB 不 putBlob，記 filePath；重啟後從路徑串流讀 chunk。
// 平台實作走 nativeFileStream adapter（Electron IPC / Capacitor plugin）。
// ============================================================

function fsStream() {
  return getNativeFileStream();
}


/** 讀取來源抽象：in-hand File（Blob.slice）或 native 路徑（IPC 串流讀）。 */
interface ChunkSource {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

function sourceFromBlob(blob: Blob): ChunkSource {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

function sourceFromPath(path: string, size: number): ChunkSource {
  const fs = fsStream();
  if (!fs) throw new Error('[FileTransfer] fs streaming unavailable');
  return { size, read: (start, end) => fs.read(path, start, end - start) };
}
// Backpressure：bufferedAmount 超過此值就等到下降；多數瀏覽器內部上限 ~16MB
const BACKPRESSURE_HIGH = 4 * 1024 * 1024;   // 4 MB
const BACKPRESSURE_LOW = 1 * 1024 * 1024;    // 1 MB
// 接收端 stall watchdog：超過此秒數沒收到新 chunk → 判定中斷（DataChannel 斷/peer 離線），
// 標 failed 讓使用者看到失敗（§教訓2 不可靜默卡 transferring）。給寬一點避開 sender 端
// 單塊最長 30s backpressure 等待造成的合法空檔。
const RECEIVE_STALL_MS = 60_000;

// ============================================================
// Types
// ============================================================

export interface FileManifestEnvelope {
  v: number;
  kind: 'file_manifest';
  msg: Message;            // 包 message（含 fileData）— receiver 直接寫入 store
}

interface ReceiverState {
  fileMeta: FileMeta;
  /** 'idb'（≤2GB，現況）| 'fs'（>2GB native stream-to-disk）。 */
  storage: 'idb' | 'fs';
  /** 每塊 plaintext 包成獨立 Blob ref（瀏覽器可選擇 spill 到 disk，避免大 Uint8Array 卡 RAM）。idb only。 */
  chunkBlobs: (Blob | undefined)[];
  /** fs mode 的去重集合（chunk 落盤後不留記憶體，得另記哪些 index 收過）。 */
  receivedSet: Set<number> | null;
  receivedCount: number;
  bytesReceived: number;
  fromDeviceId: string;
  fromPubkey: string;     // pull-model：B 點下載時，要往這個 pubkey 發 file_request
  msgId: string;
  /** 1A.5: 增量 SHA-256（hash-wasm）。chunks 進來順序消化，避免最後一次性 load 全檔 OOM。 */
  hasher: IHasher | null;
  /** 已 hash 到第幾塊（連續，from 0；遇到 hole 暫停）。 */
  hashedUpTo: number;
  /** Hash 鏈：序列化 hasher.update 呼叫，避免亂序 chunk 雙重 hash。 */
  hashChain: Promise<void>;
  /** Stall watchdog：每收一塊 reset；超過 RECEIVE_STALL_MS 沒新塊 → 判定傳輸中斷、標 failed。 */
  stallTimer: ReturnType<typeof setTimeout> | null;
}

/** 給 UI 用：紀錄哪些 pending file 來自哪個 peer，B 點下載時用這個 lookup。 */
const pendingFiles = new Map<string, { fromPubkey: string; fileMeta: FileMeta }>();

type IncomingFileListener = (msg: Message) => void;

export interface FileProgress {
  fileId: string;
  direction: 'send' | 'receive';
  bytesDone: number;
  bytesTotal: number;
  status: 'transferring' | 'complete' | 'failed';
}
type ProgressListener = (p: FileProgress) => void;

// ============================================================
// Module state
// ============================================================

let currentUserId: string | null = null;
let currentDeviceId: string | null = null;
const incomingListeners = new Set<IncomingFileListener>();
const progressListeners = new Set<ProgressListener>();
// fileId → receiver state（接收中的檔案）
const receiverStates = new Map<string, ReceiverState>();

function notifyProgress(p: FileProgress): void {
  progressListeners.forEach((cb) => { try { cb(p); } catch (e) { console.error(e); } });
}

export function onFileProgress(cb: ProgressListener): () => void {
  progressListeners.add(cb);
  return () => { progressListeners.delete(cb); };
}

type SendChunkFn = (peerPubkey: string, data: ArrayBuffer) => boolean;
type SendJsonFn = (peerPubkey: string, payload: string) => void;
type GetPeersFn = () => string[];
type GetBufferedAmountFn = (peerPubkey: string) => number;
type IsConnectedToFn = (peerPubkey: string) => boolean;
type ConnectPeerFn = (peerPubkey: string) => Promise<void>;

let _sendChunk: SendChunkFn | null = null;
let _sendJson: SendJsonFn | null = null;
let _getPeers: GetPeersFn | null = null;
let _getBufferedAmount: GetBufferedAmountFn | null = null;
let _isConnectedTo: IsConnectedToFn | null = null;
let _connectPeer: ConnectPeerFn | null = null;

let _debugChunksSent = 0;
let _debugChunksReceived = 0;
let _debugChunksDecodeFailed = 0;
let _debugChunksWithoutManifest = 0;

// Debug: 暴露給 e2e test（CR-06/H-07：release build 不曝露傳輸內部狀態）
import { DEBUG_TOOLS } from '../utils/debugFlags';
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error - 偷塞給 window
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error
  window.__aegisDebug.fileTransfer = () => ({
    initialized: !!_sendChunk,
    chunksSent: _debugChunksSent,
    chunksReceived: _debugChunksReceived,
    chunksDecodeFailed: _debugChunksDecodeFailed,
    chunksWithoutManifest: _debugChunksWithoutManifest,
    receiverStates: Array.from(receiverStates.entries()).map(([fileId, st]) => ({
      fileId: fileId.slice(0, 8),
      name: st.fileMeta.name,
      receivedCount: st.receivedCount,
      total: st.fileMeta.chunkCount,
    })),
    incomingListenersCount: incomingListeners.size,
  });
}

let _ownPubkey: string | null = null;

export function initFileTransfer(opts: {
  userId: string;
  currentDeviceId: string;
  ownPubkey: string;
  sendChunk: SendChunkFn;
  sendJson: SendJsonFn;
  getPeers: GetPeersFn;
  getBufferedAmount?: GetBufferedAmountFn;
  isConnectedTo?: IsConnectedToFn;
  connectPeer?: ConnectPeerFn;
}): void {
  currentUserId = opts.userId;
  currentDeviceId = opts.currentDeviceId;
  _ownPubkey = opts.ownPubkey;
  _sendChunk = opts.sendChunk;
  _sendJson = opts.sendJson;
  _getPeers = opts.getPeers;
  _getBufferedAmount = opts.getBufferedAmount ?? null;
  _isConnectedTo = opts.isConnectedTo ?? null;
  _connectPeer = opts.connectPeer ?? null;
  devLog('[FileTransfer] initialized');
}

export function shutdownFileTransfer(): void {
  for (const running of activeFileRequests.values()) running.controller.abort();
  activeFileRequests.clear();
  currentUserId = null;
  currentDeviceId = null;
  _ownPubkey = null;
  _sendChunk = null;
  _sendJson = null;
  _getPeers = null;
  _getBufferedAmount = null;
  _isConnectedTo = null;
  _connectPeer = null;
  for (const st of receiverStates.values()) clearStallTimer(st);  // 清掉 stall watchdog timer
  receiverStates.clear();
  // 解開所有等待中的自動接收佇列 waiter 為 'cancelled'（否則它們卡到 30 分 backstop）。
  for (const fid of Array.from(completionDeferreds.keys())) settleCompletion(fid, 'cancelled');
  incomingListeners.clear();
  progressListeners.clear();
}

export function onFileReceived(cb: IncomingFileListener): () => void {
  incomingListeners.add(cb);
  return () => { incomingListeners.delete(cb); };
}

// 每個接收中 fileId 的完成 deferred。用 deferred 而非 UI progress 事件的原因（review 2026-07-16）：
//   1. 真正的「完成」是 finalizeFile 把 blob 寫進 IDB **之後**（第 802 行），不是「最後一塊 chunk 到」。
//      靠 progress/onFileReceived 事件會太早 resolve → 下一個 200MB 在前一個還沒落盤前就開始，
//      storage precheck 仍看到舊剩餘空間。
//   2. deferred 在 fetchFile 送 request **之前**就註冊 → 無「完成事件早於 waiter」競態。
//   3. shutdown 統一 settle 'cancelled' → 佇列不會卡到 30 分 backstop。
type CompletionStatus = 'complete' | 'failed' | 'cancelled';
const completionDeferreds = new Map<string, { promise: Promise<CompletionStatus>; resolve: (s: CompletionStatus) => void }>();

/** fetchFile 在送 request 前呼叫：登記此 fileId 的完成 deferred（已存在則沿用）。 */
function registerCompletion(fileId: string): void {
  if (completionDeferreds.has(fileId)) return;
  let resolveFn!: (s: CompletionStatus) => void;
  const promise = new Promise<CompletionStatus>((res) => { resolveFn = res; });
  completionDeferreds.set(fileId, { promise, resolve: resolveFn });
}

/** finalizeFile 落盤成功 / 各失敗路徑 / failReceive / shutdown 呼叫：settle 並移除。 */
function settleCompletion(fileId: string, status: CompletionStatus): void {
  const d = completionDeferreds.get(fileId);
  if (!d) return;
  completionDeferreds.delete(fileId);
  d.resolve(status);
}

/**
 * 等某個 fileId 的「接收」走到終態（IDB 真落盤完成 / 失敗 / 取消）才 resolve —— 給自動接收佇列序列化用。
 * fetchFile 已在送 request 前 registerCompletion，所以這裡拿得到 deferred；拿不到（從未 fetch / 已
 * settle 並移除）→ 視為 'complete'（不阻塞佇列）。backstop 只防永久卡死（理論上 stall watchdog 會先兜底）。
 */
export function waitForFileComplete(
  fileId: string,
  backstopMs = 1_800_000,
): Promise<CompletionStatus | 'timeout'> {
  const d = completionDeferreds.get(fileId);
  if (!d) return Promise.resolve('complete');
  // backstop timer 正常完成後要清掉，否則會留 timer/closure 到 30 分逾時（review 2026-07-17）。
  let timer: ReturnType<typeof setTimeout>;
  const backstop = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), backstopMs); });
  return Promise.race([d.promise, backstop]).finally(() => clearTimeout(timer));
}

// ============================================================
// Sender
// ============================================================

/**
 * 串流 SHA-256：file.slice() + hasher.update() per chunk，避免 file.arrayBuffer()
 * 一次 load 整個檔案（500MB+ 在 mobile 一定 OOM）。
 *
 * 用 hash-wasm 而非 Web Crypto subtle.digest 因為後者沒有 streaming API。
 */
async function computeSha256Hex(file: File): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const HASH_CHUNK = 4 * 1024 * 1024;  // 4MB read window — 平衡 RAM 跟 read 次數
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK) {
    const end = Math.min(offset + HASH_CHUNK, file.size);
    const buf = await file.slice(offset, end).arrayBuffer();
    hasher.update(new Uint8Array(buf));
  }
  return hasher.digest('hex');
}

function genFileId(): string {
  return crypto.randomUUID();
}

/** 對所有 known peers 廣播檔案。同時寫入本機 message store。 */
export async function sendFile(file: File, caption?: string): Promise<Message> {
  // 大小硬上限 + tier gate 先做：使用者應該先看到「升級 / 太大」這類人話錯誤，
  // 而不是底層 init 錯誤（後者代表 app bootstrap 沒跑完，不是 user 行為問題）。
  // >2GB：只有 native fs streaming 可收送（IDB 單 Blob ~2GB 硬邊界）。tier gate：
  // free 超標 → throw TierGateError（UI 開 paywall）；web 平台 → 人話「太大」。
  // 另必須拿得到原生路徑（重啟後才能繼續服務接收端的 FILE_REQUEST — pull model 可能隔好幾天）。
  const sizeCheck = await checkSingleFileSize(file.size);
  const useFsStorage = file.size > MAX_FILE_SIZE;
  let srcPath: string | undefined;
  if (useFsStorage) {
    // 平台不支援 fs streaming（web/PWA / 尚未支援的行動端）→ 人話「太大」。
    if (sizeCheck === 'platform_limit') {
      throw new Error(`File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`);
    }
    // review P1（安全修）：一步完成「從真實 File 取路徑 + 登記白名單 + 確認持久化」。renderer 不碰
    // 路徑字串（XSS 無法登記任意路徑）。持久化失敗 → 送出直接失敗，不假成功（否則重啟後 canRead 擋、
    // 接收端下載拿不到）。行動端 prepareFileForRead undefined → prep undefined → 下面 throw（>2GB
    // 送出本就不支援行動端）。
    const prep = await fsStream()?.prepareFileForRead?.(file);
    if (!prep?.ok || !prep.path) {
      throw new Error(prep?.error
        ? `無法登記來源檔（${prep.error}），請重試`
        : `File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`);
    }
    srcPath = prep.path;
  }
  // Tier gate（1A.7）：免費版 2GB、Pro 不限。撞牆 → throw TierGateError → UI 開 paywall。
  await checkUploadQuota(file.size);

  if (!currentUserId || !currentDeviceId) {
    throw new Error('[FileTransfer] not initialized');
  }
  if (!_sendChunk || !_sendJson || !_getPeers) {
    throw new Error('[FileTransfer] handlers not registered');
  }
  if (!_ownPubkey) {
    throw new Error('[FileTransfer] No own pubkey to generate group key');
  }

  const fileId = genFileId();
  const sha256 = await computeSha256Hex(file);
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);

  const fileMeta: FileMeta = {
    fileId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    sha256,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    // >2GB 發送端：不進 IDB，記原生路徑（handleFileRequest 從路徑串流讀）
    ...(useFsStorage ? { fileStorage: 'fs' as const, filePath: srcPath } : {}),
  };

  // 1) 寫本機 message store（含 fileData + blob + 選填 caption）。fs mode 不放 blob
  //    （>2GB putBlob 進 IDB 必炸 — 正是這功能要繞開的邊界）。
  const msgWithFile = await addMessage(currentUserId, {
    type: 'file',
    content: caption ?? '',
    from_device_id: currentDeviceId,
    fileData: fileMeta,
    fileBlob: useFsStorage ? undefined : file,
    fileStatus: 'complete',
  });
  // 用量更新（之後撞牆判定才會即時）
  void useSubscriptionStore.getState().refreshUsage();

  // 2) 廣播 manifest — 走 shared envelope helper（peerSync 跟這裡共用同一個加密路徑，
  //    避免兩處 wire format 偷偷漂移）。沒 active key 會在 helper 內現生一把（單裝置場景）。
  const manifest: FileManifestEnvelope = { v: PROTOCOL_VERSION, kind: 'file_manifest', msg: stripBlob(msgWithFile) };
  const peers = _getPeers();
  const manifestJson = await buildEncryptedEnvelopeOrGenerate(
    currentUserId,
    _ownPubkey,
    'encrypted_file_manifest',
    manifest,
    peers,
  );
  for (const peer of peers) {
    _sendJson(peer, manifestJson);
  }

  // Pull model：A 送出 manifest 後就完成（檔案在本機）。chunks 不主動推；
  // 等接收端 B 點「下載」後發 FILE_REQUEST 過來才送。對應 PRODUCT.md：
  // 「上傳裝置：保留完整檔案；其他裝置：先收到 manifest，使用者點擊才拉取」
  return msgWithFile;
}

/** 給接收端 fetchFile 用 — 把現存於本機的檔案，按請求者要求送 chunks 過去。 */
async function sendChunksToRequester(
  source: ChunkSource,
  fileId: string,
  requesterPubkey: string,
  signal: AbortSignal,
): Promise<void> {
  if (!currentUserId) return;
  const groupId = myDevicesGroupId(currentUserId);
  const activeKey = await groupKeyService.getActiveGroupKey(groupId);
  if (!activeKey) {
    devLog('[FileTransfer] sendChunksToRequester: no active group key');
    return;
  }
  const chunkCount = Math.ceil(source.size / CHUNK_SIZE);
  await sendChunksInBackground(source, fileId, chunkCount, [requesterPubkey], activeKey.keyBase64, activeKey.keyId, signal);
}

async function sendChunksInBackground(
  file: ChunkSource,
  fileId: string,
  chunkCount: number,
  peers: string[],
  keyBase64: string,
  keyId: string,
  signal?: AbortSignal,
): Promise<void> {
  // 同一個請求重複送達 → 這條被新的取代（handleFileRequest）：安靜結束，進度由新的那條回報
  const aborted = () => signal?.aborted === true;
  if (aborted()) return;
  if (peers.length === 0) {
    devLog('[FileTransfer] No peers; skipping chunk send for', fileId);
    notifyProgress({ fileId, direction: 'send', bytesDone: file.size, bytesTotal: file.size, status: 'complete' });
    return;
  }

  // 等 DataChannel open（每個 peer 最多 5 秒，避免長 timeout 卡住整支）
  if (_isConnectedTo && _connectPeer) {
    for (const peer of peers) {
      let waited = 0;
      const MAX_WAIT = 5_000;
      while (!_isConnectedTo(peer) && waited < MAX_WAIT && !aborted()) {
        if (waited === 0) {
          void _connectPeer(peer).catch(() => { /* will retry */ });
        }
        await new Promise((r) => setTimeout(r, 200));
        waited += 200;
      }
    }
  }

  const activePeers = new Set(peers);
  let bytesSent = 0;
  for (let i = 0; i < chunkCount; i++) {
    if (aborted()) {
      devLog(`[FileTransfer] stream superseded by a newer request at chunk ${i}:`, fileId);
      return;
    }
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBytes = await file.read(start, end);
    const { ciphertext, iv } = await encryptChunkBytes(chunkBytes, keyBase64);
    const frame = encodeChunkFrame(fileId, i, ciphertext.buffer as ArrayBuffer, keyId, iv);

    for (const peer of peers) {
      if (!activePeers.has(peer)) continue;  // 此 peer 已永久失敗，不再送
      if (_getBufferedAmount) {
        let waited = 0;
        while (_getBufferedAmount(peer) > BACKPRESSURE_HIGH && waited < 30_000 && !aborted()) {
          await new Promise((r) => setTimeout(r, 50));
          waited += 50;
          if (_getBufferedAmount(peer) <= BACKPRESSURE_LOW) break;
        }
      }
      if (aborted()) return;
      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok && !aborted(); attempt++) {
        if (!_sendChunk) break;
        ok = _sendChunk(peer, frame);
        if (!ok) await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
      if (!ok && aborted()) return;
      if (ok) {
        _debugChunksSent++;
      } else {
        // S5：5 次 retry 都 false = DataChannel 關了/壞了 → 此 peer 的傳輸已不可能收齊
        // （接收端 receivedCount 永遠到不了 chunkCount → 卡死）。不再靜默丟下一塊，
        // 改成放棄該 peer + 回報 failed，讓 UI 看到失敗（§教訓2）。
        activePeers.delete(peer);
        devLog('[FileTransfer] chunk permanently failed, aborting send to peer:', i, 'peer:', peer.slice(0, 8));
        notifyProgress({ fileId, direction: 'send', bytesDone: bytesSent, bytesTotal: file.size, status: 'failed' });
      }
    }

    // 所有 peer 都失敗 → 整支 abort（不 emit complete）
    if (activePeers.size === 0) {
      devLog('[FileTransfer] all peers failed; aborting chunk send:', fileId);
      return;
    }

    bytesSent += (end - start);
    if (i % 16 === 0 || i === chunkCount - 1) {
      notifyProgress({
        fileId,
        direction: 'send',
        bytesDone: bytesSent,
        bytesTotal: file.size,
        status: i === chunkCount - 1 ? 'complete' : 'transferring',
      });
    }

    if (i % 8 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  devLog(`[FileTransfer] Sent ${fileId} (${file.size} bytes, ${chunkCount} chunks) to ${peers.length} peers`);
}

// ============================================================
// Wire frame encoding (binary)
// ============================================================

/** Header 含 keyId/iv（base64）— receiver 用來解 AES-GCM。 */
function encodeChunkFrame(
  fileId: string,
  chunkIndex: number,
  ciphertext: ArrayBuffer,
  keyId: string,
  iv: string,
): ArrayBuffer {
  const headerObj = { fileId, chunkIndex, keyId, iv };
  const headerJson = JSON.stringify(headerObj);
  const headerBytes = new TextEncoder().encode(headerJson);
  const totalLen = 4 + headerBytes.byteLength + ciphertext.byteLength;
  const out = new ArrayBuffer(totalLen);
  const view = new DataView(out);
  view.setUint32(0, headerBytes.byteLength, true);  // little-endian
  new Uint8Array(out, 4, headerBytes.byteLength).set(headerBytes);
  new Uint8Array(out, 4 + headerBytes.byteLength).set(new Uint8Array(ciphertext));
  return out;
}

interface DecodedChunkFrame {
  fileId: string;
  chunkIndex: number;
  ciphertext: Uint8Array;
  keyId: string;
  iv: string;
}

function decodeChunkFrame(frame: ArrayBuffer): DecodedChunkFrame | null {
  try {
    const view = new DataView(frame);
    const headerLen = view.getUint32(0, true);
    const headerBytes = new Uint8Array(frame, 4, headerLen);
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as {
      fileId: string;
      chunkIndex: number;
      keyId: string;
      iv: string;
    };
    if (!header.keyId || !header.iv) {
      devLog('[FileTransfer] decodeChunkFrame: missing keyId/iv (legacy plaintext frame), rejecting');
      return null;
    }
    const ciphertext = new Uint8Array(frame, 4 + headerLen);
    return { fileId: header.fileId, chunkIndex: header.chunkIndex, ciphertext, keyId: header.keyId, iv: header.iv };
  } catch (err) {
    devLog('[FileTransfer] decodeChunkFrame failed:', err);
    return null;
  }
}

/** 直接拿 raw bytes 加密（避開 encryptWithGroupKey 走 string path 的 base64 來回）。 */
async function encryptChunkBytes(
  plaintext: Uint8Array,
  keyBase64: string,
): Promise<{ ciphertext: Uint8Array; iv: string }> {
  const keyBytes = base64ToBytes(keyBase64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ivBytes = crypto.getRandomValues(new Uint8Array(12));
  // 精確取 view 範圍（與 decryptChunkBytes 對稱）— 直接用 .buffer 會在 view != buffer
  // 時（如 IPC 傳來的 Uint8Array）把 buffer 尾端垃圾一起加密。
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer as ArrayBuffer },
    cryptoKey,
    plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer,
  );
  return { ciphertext: new Uint8Array(buf), iv: bytesToBase64(ivBytes) };
}

async function decryptChunkBytes(
  ciphertext: Uint8Array,
  ivBase64: string,
  keyBase64: string,
): Promise<Uint8Array> {
  const keyBytes = base64ToBytes(keyBase64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );
  const ivBytes = base64ToBytes(ivBase64);
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes.buffer as ArrayBuffer },
    cryptoKey,
    ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer,
  );
  return new Uint8Array(buf);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ============================================================
// Receiver
// ============================================================

/** manifest fileData 數值欄位健全性檢查。惡意/壞掉的 peer 送來的 size/chunkSize/chunkCount
 *  若非正整數或彼此矛盾，會在收檔端造成錯誤 offset、提早湊滿 receivedCount、或 native 層
 *  UInt64(負值) trap crash（review 2026-07-20 #4）。在開 receiver state 前一律擋掉。 */
function isSaneFileMeta(m: FileMeta): boolean {
  const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
  if (!posInt(m.size) || !posInt(m.chunkSize) || !posInt(m.chunkCount)) return false;
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) return false;
  if (m.size === 0) return m.chunkCount === 0; // 空檔：0 chunk（chunkSize 不拘）
  // 固定協議 chunk size — 不接受對端自訂（sender 一律 CHUNK_SIZE 切塊）。放行 chunkSize=1
  // 會讓 chunkCount 爆到數億 → fetchFile 的 new Array(chunkCount) OOM crash（review P1）。
  if (m.chunkSize !== CHUNK_SIZE) return false;
  // chunkCount 必須正好覆蓋 size（最後一塊為餘數）
  if (Math.ceil(m.size / m.chunkSize) !== m.chunkCount) return false;
  return true;
}

/** 處理 manifest（peerSync 路由進來）。Pull-model：只記錄 metadata，不主動拉 chunks。 */
export async function handleManifest(envelope: FileManifestEnvelope, fromPubkey: string): Promise<void> {
  if (!currentUserId) return;
  const msg = envelope.msg;
  if (!msg.fileData) {
    devLog('[FileTransfer] manifest missing fileData');
    return;
  }
  if (!isSaneFileMeta(msg.fileData)) {
    devLog('[FileTransfer] manifest fileData failed sanity check, rejecting:', msg.fileData.fileId);
    return;
  }
  const fileId = msg.fileData.fileId;

  // 寫入 message store（pending 狀態，blob 還沒）。S6：把寄送者 pubkey 持久進 fileData，
  // 重啟後 fetchFile 才能重建 pendingFiles（否則純記憶體 pendingFiles 消失 = 死掉的下載鈕）。
  const pendingMsg: Message = {
    ...msg,
    fileData: { ...msg.fileData, fromPubkey },
    fileBlob: undefined,
    fileStatus: 'pending',
  };
  const result = await addReceivedMessage(currentUserId, pendingMsg);
  if (!result.inserted) {
    devLog('[FileTransfer] manifest already processed for', fileId);
    return;
  }

  // 記錄 metadata（B 點下載時 lookup 用）
  pendingFiles.set(fileId, { fromPubkey, fileMeta: msg.fileData });

  // 通知 UI（pending 狀態，UI 顯示「下載」按鈕；不自動開 receiver state，等 fetchFile 才開）
  incomingListeners.forEach((cb) => { try { cb(pendingMsg); } catch (e) { console.error(e); } });
  devLog(`[FileTransfer] Manifest received from ${fromPubkey.slice(0, 8)}: ${msg.fileData.name} (${msg.fileData.size} bytes) — waiting for user to tap download`);
}

/**
 * Pull-model：使用者在接收端點「下載」時呼叫。
 * 開 receiver state + 發 FILE_REQUEST 給 sender。
 */
/** fileTransfer 是否已初始化（可安全 fetchFile）。給 Timeline 自動接收前先確認，避免冷啟動搶跑。 */
export function isFileTransferReady(): boolean {
  return !!currentUserId;
}

export async function fetchFile(fileId: string): Promise<void> {
  if (!currentUserId) {
    throw new Error('[FileTransfer] not initialized');
  }
  let pending = pendingFiles.get(fileId);
  // S6：重啟後純記憶體的 pendingFiles 會空，但 manifest 訊息已持久（fileData.fromPubkey）→ 重建。
  if (!pending) {
    const stored = await findMessageByFileId(currentUserId, fileId);
    if (stored?.fileData?.fromPubkey) {
      pending = { fromPubkey: stored.fileData.fromPubkey, fileMeta: stored.fileData };
      pendingFiles.set(fileId, pending);
      devLog(`[FileTransfer] fetchFile: rebuilt pendingFiles from store for ${fileId}`);
    }
  }
  if (!pending) {
    throw new Error(`[FileTransfer] no pending manifest for fileId=${fileId}`);
  }

  // >2GB → 必須走 native fs streaming（IDB 單 Blob ~2GB 硬邊界）。收檔端也 gate
  // （HANDOFF 步驟 4）：free 超標 → TierGateError（Timeline 開 paywall）；平台不支援
  // （web/PWA / 尚未支援的行動端）→ 人話錯誤，不要下載到一半才炸。
  const useFsStorage = pending.fileMeta.size > MAX_FILE_SIZE;
  if (useFsStorage && (await checkSingleFileSize(pending.fileMeta.size, 'receive')) === 'platform_limit') {
    throw new Error('超過 2GB 的檔案請用 App 接收（桌面或手機）');
  }

  // 開接收 state（之前 handleManifest 不開，這裡才開 — 表示「使用者已點下載」）
  if (!receiverStates.has(fileId)) {
    // 找 msgId
    const msg = await findMessageByFileId(currentUserId, fileId);
    if (!msg) throw new Error(`[FileTransfer] message not found for fileId=${fileId}`);
    // fs mode：先開暫存檔（chunk 亂序到達 → main process random-access 寫入）。
    // hash 由 main 在 finalize 時串流算（chunk 不留記憶體，renderer 增量 hash 派不上場）。
    let hasher: IHasher | null = null;
    if (useFsStorage) {
      // 行動端空間預檢（桌面無 freeBytes，寫爆由 write 失敗路徑兜底）。留 256MB 餘裕。
      const free = await fsStream()!.freeBytes?.().catch(() => undefined);
      if (free !== undefined && free < pending.fileMeta.size + 256 * 1024 * 1024) {
        throw new Error(`裝置可用空間不足（需要 ${Math.ceil(pending.fileMeta.size / 1024 / 1024 / 1024)}GB 以上），請清出空間後重試`);
      }
      const r = await fsStream()!.open(fileId);
      if (!r.ok) throw new Error(`無法建立暫存檔：${r.error ?? 'unknown'}`);
    } else {
      hasher = await createSHA256();
      hasher.init();
    }
    receiverStates.set(fileId, {
      fileMeta: pending.fileMeta,
      storage: useFsStorage ? 'fs' : 'idb',
      chunkBlobs: useFsStorage ? [] : new Array(pending.fileMeta.chunkCount),
      receivedSet: useFsStorage ? new Set<number>() : null,
      receivedCount: 0,
      bytesReceived: 0,
      fromDeviceId: msg.from_device_id ?? '',
      fromPubkey: pending.fromPubkey,
      msgId: msg.id,
      hasher,
      hashedUpTo: 0,
      hashChain: Promise.resolve(),
      stallTimer: null,
    });
    armStallWatchdog(fileId);  // S4：開始等 chunks，啟動中斷偵測（斷線/peer 離線會觸發）
  }

  // 在送 request 前登記完成 deferred（自動接收佇列 await 它；避免「完成事件早於 waiter」競態）。
  registerCompletion(fileId);

  // 空檔（chunkCount=0）：sender 不會送任何 chunk → handleChunkFrame 永不觸發完成判定 →
  // 只能等 60s watchdog 判失敗（review P2）。直接 finalize：hasher 未 update → digest 為
  // 空檔 SHA-256、與 manifest 對得上；idb 路徑寫入空 Blob。不需送 FILE_REQUEST。
  if (pending.fileMeta.chunkCount === 0) {
    await finalizeFile(fileId);
    return;
  }

  // 發 FILE_REQUEST 走 peerSync（peerSync 會用 group key 加密）。
  // 若送 request 直接 throw（peer 未連 / 加密失敗），別讓 receiver state + deferred 卡到 60 秒
  // watchdog（review 2026-07-17）→ 立刻 failReceive 清掉並 settle，再把錯誤往上拋。
  const { sendFileRequest } = await import('./peerSync');
  try {
    await sendFileRequest(pending.fromPubkey, fileId);
  } catch (err) {
    await failReceive(fileId, 'send FILE_REQUEST failed');
    throw err;
  }

  // 通知 UI 進入 transferring 狀態
  notifyProgress({
    fileId,
    direction: 'receive',
    bytesDone: 0,
    bytesTotal: pending.fileMeta.size,
    status: 'transferring',
  });

  devLog(`[FileTransfer] fetchFile: requested ${fileId} from ${pending.fromPubkey.slice(0, 8)}`);
}

/**
 * 正在傳的「peer＋fileId」（對應 TofuTalk 8f00b1e：TofuTalk B7、審查 HIGH-1）：收端的 FILE_REQUEST 走 outbox、
 * 要等整個檔案傳完才 ACK，傳送中 DataChannel 原地重開就會再收到同一個請求（使用者手動重試也是）。
 * - 以前每次都開一條新的完整串流 → 同一個檔案同時傳好幾份。
 * - 只接上正在跑的那一條也不行（TofuTalk 06442d1）→ 舊通道裡掉的 chunk 永遠不會重送，收端 60 秒後判失敗。
 * 現在：重複的請求先停掉正在跑的那一條（每塊、等通道、backpressure 等待中都檢查），等它真的停下再從第 0 塊
 * 重新開始；收端已有的 chunk 會略過。同一個 peer＋fileId 任何時候最多一條在送。
 */
interface ActiveFileRequest {
  controller: AbortController;
  /** 這一條串流（含被取代時提早結束）跑完 */
  done: Promise<void>;
}
const activeFileRequests = new Map<string, ActiveFileRequest>();

/**
 * Sender 收到 FILE_REQUEST：找本機檔案，sendChunksInBackground 給請求者。
 * 回傳的 promise 等到最後接手的那一條送完才結束（peerSync 這時才回 ACK）：被重新開始取代的請求跟著新的那條。
 */
export function handleFileRequest(fileId: string, fromPubkey: string): Promise<void> {
  const key = `${fromPubkey}\u0000${fileId}`;
  const previous = activeFileRequests.get(key);
  if (previous) {
    devLog(`[FileTransfer] duplicate FILE_REQUEST while streaming fileId=${fileId} — restarting from chunk 0`);
    previous.controller.abort();
  }
  const controller = new AbortController();
  const done: Promise<void> = (async () => {
    if (previous) await previous.done.catch(() => { /* 舊的那條失敗也一樣重新開始 */ });
    if (controller.signal.aborted) return;  // 等舊的停下時又來了更新的請求
    await serveFileRequest(fileId, fromPubkey, controller.signal);
  })().finally(() => { if (activeFileRequests.get(key)?.done === done) activeFileRequests.delete(key); });
  const entry: ActiveFileRequest = { controller, done };
  activeFileRequests.set(key, entry);
  return untilServed(key, entry);
}

async function untilServed(key: string, entry: ActiveFileRequest): Promise<void> {
  let current = entry;
  for (;;) {
    let failure: { error: unknown } | null = null;
    try { await current.done; } catch (error) { failure = { error }; }
    const next = activeFileRequests.get(key);
    if (next && next !== current) { current = next; continue; }  // 被重新開始取代 → 等新的那條
    if (failure) throw failure.error;
    return;
  }
}

async function serveFileRequest(fileId: string, fromPubkey: string, signal: AbortSignal): Promise<void> {
  if (!currentUserId) return;
  const msg = await findMessageByFileId(currentUserId, fileId);
  let source: ChunkSource | null = null;
  if (msg?.fileBlob) {
    source = sourceFromBlob(msg.fileBlob);
  } else if (msg?.fileData?.fileStorage === 'fs' && msg.fileData.filePath && fsStream()) {
    // >2GB fs 檔：驗檔案還在且大小沒變（使用者可能刪了/搬了源檔）才服務
    const st = await fsStream()!.stat(msg.fileData.filePath);
    if (st && st.size === msg.fileData.size) {
      source = sourceFromPath(msg.fileData.filePath, st.size);
    } else {
      devLog(`[FileTransfer] handleFileRequest: fs source missing/changed fileId=${fileId} path=${msg.fileData.filePath}`);
    }
  }
  if (!source) {
    devLog(`[FileTransfer] handleFileRequest: file not found locally fileId=${fileId}`);
    return;
  }
  await sendChunksToRequester(source, fileId, fromPubkey, signal);
}

/** 處理 binary chunk frame（peerSync 路由進來）。 */
export async function handleChunkFrame(frame: ArrayBuffer, fromPubkey: string): Promise<void> {
  if (!currentUserId) return;
  _debugChunksReceived++;
  const decoded = decodeChunkFrame(frame);
  if (!decoded) {
    _debugChunksDecodeFailed++;
    return;
  }

  const state = receiverStates.get(decoded.fileId);
  if (!state) {
    _debugChunksWithoutManifest++;
    devLog('[FileTransfer] chunk before manifest, dropping:', decoded.fileId, decoded.chunkIndex);
    return;
  }

  // chunk 必須來自當初送 manifest 的同一台裝置（review P2）。另一台已配對裝置只要知道 fileId
  // 就能注入合法加密、內容卻錯的 chunk → 拖到 finalize 才 SHA 驗證失敗、白傳一場。來源不符即丟。
  if (fromPubkey !== state.fromPubkey) {
    devLog('[FileTransfer] chunk from unexpected peer, dropping:', fromPubkey.slice(0, 8), '!=', state.fromPubkey.slice(0, 8));
    return;
  }

  // chunkIndex 驗證（review 2026-07-20 #4）：JSON 來的 index 若非「整數 ∧ ≥0 ∧ <chunkCount」，
  // offset = index×chunkSize 會是負值/越界 → iOS UInt64(offset) runtime trap（無法 catch，直接 crash）；
  // 也會提早湊滿 receivedCount 讓傳輸失敗。壞掉/受控的已配對裝置能藉此 crash 收檔端 → 一律先擋。
  if (!Number.isInteger(decoded.chunkIndex) || decoded.chunkIndex < 0 || decoded.chunkIndex >= state.fileMeta.chunkCount) {
    devLog('[FileTransfer] chunk index out of range, dropping:', decoded.chunkIndex, '/', state.fileMeta.chunkCount);
    return;
  }

  // 解密 chunk
  let plaintext: Uint8Array;
  try {
    const keyRecord = await groupKeyService.getGroupKeyById(decoded.keyId);
    if (!keyRecord) {
      devLog('[FileTransfer] chunk uses unknown keyId, dropping:', decoded.keyId, 'idx:', decoded.chunkIndex);
      return;
    }
    plaintext = await decryptChunkBytes(decoded.ciphertext, decoded.iv, keyRecord.keyBase64);
  } catch (err) {
    devLog('[FileTransfer] chunk decrypt failed:', err, 'idx:', decoded.chunkIndex);
    return;
  }

  // chunk plaintext 長度驗證：非最後一塊必須 = chunkSize，最後一塊 = 餘數（review #4）。
  // 過長的 chunk 會讓 fs 落盤時越界寫、或 idb 拼接出錯誤大小的檔。
  const isLastChunk = decoded.chunkIndex === state.fileMeta.chunkCount - 1;
  const expectedLen = isLastChunk
    ? state.fileMeta.size - decoded.chunkIndex * state.fileMeta.chunkSize
    : state.fileMeta.chunkSize;
  if (plaintext.byteLength !== expectedLen) {
    devLog('[FileTransfer] chunk length mismatch, dropping:', plaintext.byteLength, '!=', expectedLen, 'idx:', decoded.chunkIndex);
    return;
  }

  const alreadyHave = state.storage === 'fs'
    ? state.receivedSet!.has(decoded.chunkIndex)
    : state.chunkBlobs[decoded.chunkIndex] !== undefined;
  if (!alreadyHave) {
    if (state.storage === 'fs') {
      // >2GB：plaintext 直接 random-access 落盤（offset = index * chunkSize；
      // 亂序到達沒差）。不留任何 chunk 在記憶體。
      // 先登記再 await：同 index 並發到達時第二筆會被 alreadyHave 擋掉（雙計數會讓
      // receivedCount 提早到頂 → finalize 缺塊）。寫失敗再回滾。
      state.receivedSet!.add(decoded.chunkIndex);
      const w = await fsStream()!.write(decoded.fileId, decoded.chunkIndex * state.fileMeta.chunkSize, plaintext);
      // await 期間 watchdog 可能已 failReceive 清了 state → 這筆已無效，別再計數/finalize
      if (!receiverStates.has(decoded.fileId)) return;
      if (!w.ok) {
        state.receivedSet!.delete(decoded.chunkIndex);
        await failReceive(decoded.fileId, `fs write failed: ${w.error ?? 'unknown'}`);
        return;
      }
    } else {
      // 包成 Blob ref：瀏覽器可選擇 disk-spill；不像 Uint8Array 一定占 heap RAM。
      // cast 跳過 TS strict mode 對 ArrayBufferLike vs ArrayBuffer 的 SharedArrayBuffer 顧慮。
      state.chunkBlobs[decoded.chunkIndex] = new Blob([plaintext as BlobPart]);
      // 增量 hash：把連續可用的 chunks 餵進 hasher（亂序到達會等到前面的 chunk 補齊）
      advanceHasher(state);
    }
    state.receivedCount++;
    state.bytesReceived += plaintext.byteLength;

    // S4：有進度 → 重置 stall watchdog（完成那塊由 finalizeFile 的 clearStallTimer 收掉）
    armStallWatchdog(decoded.fileId);

    // 每 16 chunks 回報一次（避免 React render 風暴）
    if (state.receivedCount % 16 === 0 || state.receivedCount === state.fileMeta.chunkCount) {
      notifyProgress({
        fileId: decoded.fileId,
        direction: 'receive',
        bytesDone: state.bytesReceived,
        bytesTotal: state.fileMeta.size,
        status: state.receivedCount === state.fileMeta.chunkCount ? 'complete' : 'transferring',
      });
    }
  }

  if (state.receivedCount === state.fileMeta.chunkCount) {
    await finalizeFile(decoded.fileId);
  }
}

/**
 * 把連續可用的 chunks 餵給 hasher。Promise chain 序列化，避免亂序 chunk 雙重 hash。
 * 不 await — fire-and-forget，由 finalizeFile await state.hashChain 收尾。
 */
function advanceHasher(state: ReceiverState): void {
  state.hashChain = state.hashChain.then(async () => {
    while (state.hasher && state.chunkBlobs[state.hashedUpTo]) {
      const blob = state.chunkBlobs[state.hashedUpTo]!;
      const buf = await blob.arrayBuffer();
      state.hasher.update(new Uint8Array(buf));
      state.hashedUpTo++;
    }
  }).catch((err) => {
    devLog('[FileTransfer] hasher chain error:', err);
  });
}

/** 重置接收端 stall watchdog（每收到新 chunk 呼叫一次）。完成/失敗時由 clearStallTimer 清掉。 */
function armStallWatchdog(fileId: string): void {
  const state = receiverStates.get(fileId);
  if (!state) return;
  if (state.stallTimer) clearTimeout(state.stallTimer);
  state.stallTimer = setTimeout(() => { void failReceive(fileId, 'stalled'); }, RECEIVE_STALL_MS);
}

function clearStallTimer(state: ReceiverState): void {
  if (state.stallTimer) { clearTimeout(state.stallTimer); state.stallTimer = null; }
}

/**
 * 接收中斷 → 標 failed（§教訓2 不可靜默卡 transferring）。清掉 receiver state + watchdog，
 * 更新訊息 fileStatus='failed' 並通知 UI。manifest + pendingFiles 仍在 → 使用者可重新點下載重試。
 */
async function failReceive(fileId: string, reason: string): Promise<void> {
  const state = receiverStates.get(fileId);
  if (!state) return;
  clearStallTimer(state);
  receiverStates.delete(fileId);
  settleCompletion(fileId, 'failed'); // 解開自動接收佇列的 waiter
  // fs mode：關掉並刪掉暫存檔（重試會重新 open 從零收）
  if (state.storage === 'fs') void fsStream()?.abort(fileId);
  devLog(`[FileTransfer] receive FAILED (${reason}): ${fileId} at ${state.receivedCount}/${state.fileMeta.chunkCount}`);
  if (currentUserId) {
    await updateMessage(currentUserId, state.msgId, { fileStatus: 'failed' }).catch(() => {});
  }
  notifyProgress({
    fileId, direction: 'receive',
    bytesDone: state.bytesReceived, bytesTotal: state.fileMeta.size,
    status: 'failed',
  });
  // 把 failed 後的訊息推給 UI（下載按鈕回來，可重試）
  if (currentUserId) {
    const updated = await findMessageByFileId(currentUserId, fileId).catch(() => null);
    if (updated) incomingListeners.forEach((cb) => { try { cb(updated); } catch (e) { console.error(e); } });
  }
}

async function finalizeFile(fileId: string): Promise<void> {
  if (!currentUserId) return;
  const state = receiverStates.get(fileId);
  if (!state) return;
  clearStallTimer(state);
  receiverStates.delete(fileId);

  // 等所有 hasher.update 完成（hashedUpTo 應追上 chunkCount）
  await state.hashChain;
  // 任一失敗路徑：更新訊息 failed + 發 failed progress（review：這些路徑原本沒發 progress）+ settle
  // 佇列 deferred（否則自動接收佇列卡到 backstop）。
  const failFinalize = async (reason: string) => {
    devLog(`[FileTransfer] finalize failed (${reason}) fileId=${fileId}`);
    await updateMessage(currentUserId!, state.msgId, { fileStatus: 'failed' }).catch(() => {});
    notifyProgress({
      fileId, direction: 'receive',
      bytesDone: state.bytesReceived, bytesTotal: state.fileMeta.size,
      status: 'failed',
    });
    settleCompletion(fileId, 'failed');
  };

  if (state.storage === 'fs') {
    // >2GB：main process 收尾 — size 驗證 + 串流 SHA-256 + rename 到正式路徑。
    const r = await fsStream()!.finalize(fileId, state.fileMeta.sha256, state.fileMeta.size, state.fileMeta.name);
    if (!r.ok || !r.path) { await failFinalize(`fs finalize: ${r.error ?? 'unknown'}`); return; }
    try {
      await updateMessage(currentUserId, state.msgId, {
        fileStatus: 'complete',
        fileDataPatch: { fileStorage: 'fs', filePath: r.path },
      });
    } catch (err) {
      devLog('[FileTransfer] finalize: fs metadata update failed:', err);
      void fsStream()?.delete(r.path);  // metadata 沒落 → 檔案孤兒，清掉
      await failFinalize('db update failed');
      return;
    }
  } else {
    if (!state.hasher) { await failFinalize('hasher missing'); return; }
    if (state.hashedUpTo !== state.fileMeta.chunkCount) {
      await failFinalize(`hashedUpTo=${state.hashedUpTo} != chunkCount=${state.fileMeta.chunkCount}`);
      return;
    }
    const sha256 = state.hasher.digest('hex');
    if (sha256 !== state.fileMeta.sha256) { await failFinalize('sha256 mismatch'); return; }

    // 組最終 blob — Blob ctor 從 Blob[] 拼接是 ref-only，不會把 bytes 全載入 RAM。
    // 直接交給 IDB；putBlob 內部 IDB transaction 會處理 disk persistence。
    const parts = state.chunkBlobs.filter((b): b is Blob => b !== undefined);
    const finalBlob = new Blob(parts as BlobPart[], { type: state.fileMeta.mimeType });

    // 寫入 blob + 標 complete（updateMessage → putBlob → IDB）
    try {
      await updateMessage(currentUserId, state.msgId, { fileBlob: finalBlob, fileStatus: 'complete' });
    } catch (err) {
      // QuotaExceededError：IDB 寫入失敗（裝置空間不足）
      devLog(`[FileTransfer] finalize: putBlob failed (quota?):`, err);
      await failFinalize('idb write failed (quota?)');
      return;
    }
  }

  // ✅ 真正落盤完成才 settle 'complete'（佇列的下一個檔到這裡才會開始）。
  settleCompletion(fileId, 'complete');

  // 通知 UI（complete 狀態）
  const updated = await findMessageByFileId(currentUserId, fileId);
  if (updated) {
    incomingListeners.forEach((cb) => { try { cb(updated); } catch (e) { console.error(e); } });
  }
  void useSubscriptionStore.getState().refreshUsage();
  devLog(`[FileTransfer] File complete: ${state.fileMeta.name} (${state.fileMeta.size} bytes)`);
}

// ============================================================
// Helpers
// ============================================================

/** Manifest 出線前剝掉本機限定欄位：blob、filePath/fileStorage（本機路徑不外洩、
 *  接收端存哪由接收端自己決定）、fromPubkey（接收端欄位）。 */
function stripBlob(msg: Message): Message {
  if (!msg.fileData) return { ...msg, fileBlob: undefined };
  const { fileStorage: _s, filePath: _p, fromPubkey: _f, ...meta } = msg.fileData;
  return { ...msg, fileBlob: undefined, fileData: meta };
}
