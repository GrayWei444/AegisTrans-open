/**
 * Group Key Service — ADR-016 群組共享金鑰
 *
 * 群組加密使用 AES-256-GCM 共享金鑰（Group Key）。
 * - 一次加密，全員可解（啟用 BT Seed 離線同步）
 * - 成員離開/被移除 → 立即輪換，72 小時新舊雙發
 * - 任何持有 Key 的成員都能補發（去中心化）
 * - 舊 Key 保留 30 天用於解密歷史訊息
 */

import { generateId } from '../utils/secureId';
import { GROUP_CONSTANTS } from '../types';
import * as database from './database';
import { getPublicKeyBase64Sync } from './identity';

// ============================================
// 類型定義
// ============================================

export interface GroupKeyRecord {
  groupId: string;
  keyId: string;
  /** AES-256-GCM raw key bytes, Base64 encoded */
  keyBase64: string;
  createdAt: number;
  createdBy: string;       // 生成者公鑰
  isActive: boolean;       // 當前使用中（由 recomputeActiveKeys 推導，見下方「Active key 集合」）
  expiresAt: number;       // createdAt + 30 天
  /** 撤銷裝置後的輪換 key（自己輪換的，或收到 isRotation:true 的分發） */
  isRotation: boolean;
  /** 把這把 key 交給本機的裝置公鑰：自己生的＝自己的公鑰，收到的＝送來的那台；null＝加欄位之前就存在的舊資料列 */
  distributor: string | null;
  /** 本機存入的順序（saveGroupKey 給，只增不減；不看任何裝置的時鐘）。還沒存過的紀錄沒有 */
  storedSeq?: number;
  /** 回應 group_key_request 收到的 key：只拿來解密，永遠不算 active（之後以一般分發收到才算） */
  decryptOnly: boolean;
}

export interface EncryptedGroupMessage {
  /** 用哪把 Group Key 加密 */
  keyId: string;
  /** AES-256-GCM 密文 (Base64) */
  ciphertext: string;
  /** AES-256-GCM IV (Base64) */
  iv: string;
  /** 過渡期舊 Key 加密版本 */
  legacyKeyId?: string;
  legacyCiphertext?: string;
  legacyIv?: string;
}

export interface SignedGroupMessage {
  messageId: string;
  groupId: string;
  senderId: string;
  timestamp: number;
  type: string;
  /** 加密後資料 */
  encrypted: EncryptedGroupMessage;
  /** Ed25519 簽名 (簽明文, Base64) */
  signature: string;
}

// ============================================
// Key 生成
// ============================================

/**
 * 生成新的 AES-256-GCM Group Key
 */
export async function generateGroupKey(
  groupId: string,
  createdBy: string,
): Promise<GroupKeyRecord> {
  // 生成 AES-256-GCM key
  const cryptoKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — 需要匯出分發給成員
    ['encrypt', 'decrypt'],
  );

  // 匯出 raw bytes → Base64
  const rawBytes = new Uint8Array(await crypto.subtle.exportKey('raw', cryptoKey));
  const keyBase64 = bytesToBase64(rawBytes);

  const now = Date.now();
  const keyId = generateId('gk');

  return {
    groupId,
    keyId,
    keyBase64,
    createdAt: now,
    createdBy,
    isActive: true,
    expiresAt: now + GROUP_CONSTANTS.KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    isRotation: false,
    distributor: createdBy,
    decryptOnly: false,
  };
}

// ============================================
// 加密 / 解密
// ============================================

/**
 * 用 Group Key 加密明文
 */
export async function encryptWithGroupKey(
  plaintext: string,
  keyBase64: string,
): Promise<{ ciphertext: string; iv: string }> {
  const keyBytes = base64ToBytes(keyBase64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    encoded.buffer as ArrayBuffer,
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuf)),
    iv: bytesToBase64(iv),
  };
}

/**
 * 用 Group Key 解密密文
 */
export async function decryptWithGroupKey(
  ciphertextBase64: string,
  ivBase64: string,
  keyBase64: string,
): Promise<string> {
  const keyBytes = base64ToBytes(keyBase64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  );

  const ciphertext = base64ToBytes(ciphertextBase64);
  const iv = base64ToBytes(ivBase64);

  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    ciphertext.buffer as ArrayBuffer,
  );

  return new TextDecoder().decode(plaintextBuf);
}

// ============================================
// Key 儲存 (SQLite)
// ============================================

/**
 * 儲存 Group Key 到 SQLite。stored_seq＝目前最大值＋1，在同一個陳述式裡算（不在寫入佇列裡呼叫也不會重號）。
 */
export async function saveGroupKey(record: GroupKeyRecord): Promise<void> {
  await database.run(
    `INSERT OR REPLACE INTO group_keys
     (group_id, key_id, key_base64, created_at, created_by, is_active, expires_at, is_rotation, distributor, decrypt_only, stored_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(stored_seq), 0) + 1 FROM group_keys))`,
    [
      record.groupId,
      record.keyId,
      record.keyBase64,
      record.createdAt,
      record.createdBy,
      record.isActive ? 1 : 0,
      record.expiresAt,
      record.isRotation ? 1 : 0,
      record.distributor,
      record.decryptOnly ? 1 : 0,
    ],
  );
}

/**
 * 取得群組的當前 active key
 */
export async function getActiveGroupKey(groupId: string): Promise<GroupKeyRecord | null> {
  const rows = await database.query(
    'SELECT * FROM group_keys WHERE group_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1',
    [groupId],
  );
  if (rows.length === 0) return null;
  return rowToRecord(rows[0]);
}

/**
 * 用 keyId 取得特定 key（解密歷史訊息用）
 */
export async function getGroupKeyById(keyId: string): Promise<GroupKeyRecord | null> {
  const rows = await database.query(
    'SELECT * FROM group_keys WHERE key_id = ?',
    [keyId],
  );
  if (rows.length === 0) return null;
  return rowToRecord(rows[0]);
}

/**
 * 取得群組的所有 keys（含歷史）
 */
export async function getAllGroupKeys(groupId: string): Promise<GroupKeyRecord[]> {
  const rows = await database.query(
    'SELECT * FROM group_keys WHERE group_id = ? ORDER BY created_at DESC',
    [groupId],
  );
  return rows.map(rowToRecord);
}

/**
 * 取得前一把 key（雙發過渡期用）
 */
export async function getPreviousGroupKey(groupId: string): Promise<GroupKeyRecord | null> {
  const rows = await database.query(
    'SELECT * FROM group_keys WHERE group_id = ? AND is_active = 0 ORDER BY created_at DESC LIMIT 1',
    [groupId],
  );
  if (rows.length === 0) return null;
  return rowToRecord(rows[0]);
}

// ============================================
// Key 輪換
// ============================================

/**
 * 輪換 Group Key（成員離開/被移除時呼叫）
 *
 * 1. 生成新 key，記成「自己交出的輪換 key」；createdAt 見 rotationCreatedAt（最多到「現在＋5 分鐘＋1」），
 *    日期超過「現在＋5 分鐘」的資料列先拉回那個上限（pullBackFutureKeys）
 * 2. 重算 active 集合：新 key 成為錨點，比它舊的都停用（呼叫前先用 observeAccountDevices 給剩下的裝置清單，
 *    被撤裝置交來的 key 才不會留著）
 * 3. 返回新 key + 輪換前的 active key（記錄用）
 */
export function rotateGroupKey(
  groupId: string,
  rotatedBy: string,
): Promise<{ newKey: GroupKeyRecord; oldKey: GroupKeyRecord | null }> {
  return serialized(async () => {
    const previous = await getActiveGroupKey(groupId);
    const generated = await generateGroupKey(groupId, rotatedBy);
    const createdAt = rotationCreatedAt(await getAllGroupKeys(groupId), generated.createdAt);
    await pullBackFutureKeys(groupId, generated.createdAt + MAX_CREATED_AT_SKEW_MS);
    const newKey: GroupKeyRecord = {
      ...generated,
      createdAt,
      expiresAt: createdAt + GROUP_CONSTANTS.KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      isRotation: true,
    };
    await saveGroupKey(newKey);
    await recomputeActiveKeys(groupId, null);
    const oldKey = previous ? await getGroupKeyById(previous.keyId) : null;
    return { newKey, oldKey };
  });
}

/**
 * 輪換 key 的 createdAt：比本機每一把日期在「現在＋5 分鐘」以內的 key 都新（審查 MEDIUM-1：別台時鐘偏快、撤銷前就有的
 * key，別的裝置之後才收到也不會把它當成比輪換新——收到時一樣夾在 5 分鐘內），但最多到「現在＋5 分鐘＋1」。
 * 日期超過上限的資料列（舊版存的沒夾值日期、本機時鐘往回調之前的 key）不繼承（審查 round-3 MEDIUM-1，對應 TofuTalk
 * cccba3b）：以前輪換跟著帶上一年後的日期，之後別台撤銷再輪換，在這台永遠比較舊，這台一直用自己那把（後來被撤的裝置
 * 手上有）。其中可能當錨點的輪換 key 會被拉回上限（pullBackFutureKeys），新的輪換一樣勝過它；其他的不需要：
 * 一般 key 在輪換之前就存了（stored_seq），沒有交來裝置的舊資料列遇到錨點就停用，補發的只解密。
 */
function rotationCreatedAt(keys: readonly GroupKeyRecord[], now: number): number {
  const ceiling = now + MAX_CREATED_AT_SKEW_MS;
  let newest = -Infinity;
  for (const key of keys) {
    if (key.createdAt <= ceiling) newest = Math.max(newest, key.createdAt);
    else if (key.isRotation && key.distributor !== null && !key.decryptOnly) newest = ceiling;
  }
  return Math.max(now, newest + 1);
}

/** 日期超過 `ceiling` 的資料列拉回 ceiling（跟收到時的夾值一樣；到期時間也跟著不超過 ceiling＋保留天數） */
async function pullBackFutureKeys(groupId: string, ceiling: number): Promise<void> {
  await database.run(
    'UPDATE group_keys SET created_at = ?, expires_at = MIN(expires_at, ?) WHERE group_id = ? AND created_at > ?',
    [ceiling, ceiling + GROUP_CONSTANTS.KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000, groupId, ceiling],
  );
}

/**
 * 群組沒有 active key 就生一把自己的（myDevicesGroup.ensureMyDevicesGroupKey）。在寫入佇列裡做，存完照常重算：
 * 以前在佇列外面存（is_active=1 直接寫入），手機上每個 SQLite 呼叫都是原生橋接，重算「讀全部 → 寫回」中間插進這個
 * INSERT → 寫回時把新 key 設成 is_active=0，回傳（並分發）的 key 不是這台送訊息用的 key（審查 LOW-6）。
 * 還沒抓到裝置清單時，生 key 的這台（自己）算數。
 */
export function ensureActiveGroupKey(
  groupId: string,
  createdBy: string,
): Promise<{ key: GroupKeyRecord; created: boolean }> {
  return serialized(async () => {
    const existing = await getActiveGroupKey(groupId);
    if (existing) return { key: existing, created: false };
    const fresh = await generateGroupKey(groupId, createdBy);
    await saveGroupKey(fresh);
    await recomputeActiveKeys(groupId, createdBy);
    return { key: (await getGroupKeyById(fresh.keyId)) ?? fresh, created: true };
  });
}

/**
 * 檢查是否在雙發過渡期內
 * （上一把 key 被停用不到 72 小時）
 */
export async function isInTransitionPeriod(groupId: string): Promise<boolean> {
  const previousKey = await getPreviousGroupKey(groupId);
  if (!previousKey) return false;

  const transitionMs = GROUP_CONSTANTS.KEY_TRANSITION_HOURS * 60 * 60 * 1000;
  return Date.now() - previousKey.createdAt < transitionMs;
}

/**
 * 清理過期 keys（超過 30 天）
 */
export async function cleanupExpiredKeys(): Promise<number> {
  const now = Date.now();
  return await database.run(
    'DELETE FROM group_keys WHERE expires_at < ? AND is_active = 0',
    [now],
  );
}

// ============================================
// Key 分發封包（透過 1-1 Ratchet P2P 傳送）
// ============================================

/** Key 分發封包格式 */
export interface GroupKeyDistribution {
  type: 'group_key_distribution';
  groupId: string;
  keyId: string;
  keyBase64: string;        // AES-256-GCM raw key, Base64
  createdAt: number;
  createdBy: string;
  /** 是否是輪換（通知收件人舊 key 已停用） */
  isRotation: boolean;
  /**
   * 回應 group_key_request 的補發（dispatchGroupKeyByIdTo）：收方只拿來解那則訊息，永遠不設成 active（審查 LOW-1）。
   * 補發可以是本機存著的任何 key——包括被撤的裝置撤銷前塞來的；一般分發（配對時送自己的 active key、輪換）不帶。
   */
  decryptOnly?: boolean;
}

/** 缺 key recovery：收方解不開某 keyId 時，透過 1-1 Ratchet 向 sender 要這把 key。 */
export interface GroupKeyRequest {
  type: 'group_key_request';
  groupId: string;
  keyId: string;
  requestedAt: number;
}

/**
 * 建立 Key 分發封包（送到 P2P 前需用 1-1 Ratchet 加密）
 */
export function createKeyDistribution(
  key: GroupKeyRecord,
  isRotation: boolean,
): GroupKeyDistribution {
  return {
    type: 'group_key_distribution',
    groupId: key.groupId,
    keyId: key.keyId,
    keyBase64: key.keyBase64,
    createdAt: key.createdAt,
    createdBy: key.createdBy,
    isRotation,
  };
}

/** 送方自填的 createdAt 最多信到「現在＋5 分鐘」：active key 依 createdAt 挑，遠未來的時間會把那把 key 釘死 */
const MAX_CREATED_AT_SKEW_MS = 5 * 60 * 1000;

/**
 * 處理收到的 Key 分發封包。`from`＝送來的裝置公鑰（ratchet session 認證過；呼叫端已確認它仍是本帳號裝置，稽核 B1）。
 */
export function handleKeyDistribution(
  dist: GroupKeyDistribution,
  from: string,
): Promise<void> {
  return serialized(async () => {
    // 已存在的 keyId 不覆蓋（稽核 B11）：以前 INSERT OR REPLACE，同一個 keyId 能被換成別的位元組，
    //   被輪換掉的舊 key 重新送來（例如回應 group_key_request）也會被重新設成 active
    const existing = await getGroupKeyById(dist.keyId);
    if (existing && (existing.keyBase64 !== dist.keyBase64 || existing.groupId !== dist.groupId)) {
      console.warn('[groupKey] refusing to overwrite existing keyId', dist.keyId.slice(0, 12));
      return;
    }
    // 回應 key request 的補發只拿來解密（審查 LOW-1：被撤裝置塞給 B 的 key 不能經由 B 的補發變成新裝置的 active key）
    const decryptOnly = dist.decryptOnly === true;
    const isRotation = dist.isRotation === true && !decryptOnly;
    if (!existing) {
      const createdAt = Math.min(dist.createdAt, Date.now() + MAX_CREATED_AT_SKEW_MS);
      await saveGroupKey({
        groupId: dist.groupId,
        keyId: dist.keyId,
        keyBase64: dist.keyBase64,
        createdAt,
        createdBy: dist.createdBy,
        isActive: false,   // 下面重算
        expiresAt: createdAt + GROUP_CONSTANTS.KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        isRotation,
        distributor: from,
        decryptOnly,
      });
    } else if (existing.decryptOnly && !decryptOnly) {
      // 先當補發收到（只解密），之後才以一般分發／輪換收到同一把：照現在才收到的一般分發／輪換算（存入順序也算現在）
      await database.run(
        `UPDATE group_keys SET decrypt_only = 0, is_rotation = ?, distributor = ?,
           stored_seq = (SELECT COALESCE(MAX(stored_seq), 0) + 1 FROM group_keys) WHERE key_id = ?`,
        [isRotation ? 1 : 0, from, dist.keyId],
      );
    } else if (isRotation && !existing.isRotation) {
      // 先當一般 key 收到（配對、補發），之後才到同一把的輪換通知：照輪換算（輪換一到就生效，跟以前一樣）
      await database.run('UPDATE group_keys SET is_rotation = 1, distributor = ? WHERE key_id = ?', [from, dist.keyId]);
    }
    await recomputeActiveKeys(dist.groupId, from);
  });
}

// ============================================
// Active key 集合（由資料推導，不看到貨順序）
// ============================================
//
// 以前輪換一到就停用其他所有 key：較早的輪換晚到（broker 排隊、離線補送）會把 active key 倒回舊的（對應 TofuTalk 8e3b49d，審查 LOW）；
// 只停用比較舊的又擋不住快被撤銷的裝置先塞一把未來時間的 key（稽核 B11）。現在每次重算：
//   - 錨點＝createdAt 最新、交來的裝置仍在帳號上（或是自己）的輪換 key；
//   - 錨點＋比錨點新、而且在錨點之後才存進本機（stored_seq）、仍在帳號上的裝置交來的一般 key 是 active，其他都不是。
//     只比 createdAt 不夠（審查 MEDIUM-1）：時鐘偏快的裝置的 key（+5 分鐘夾值內，或自己的時鐘快 1 小時生的 key）
//     日期在輪換之後，撤銷前就已經在大家手上——被撤的裝置也有。撤銷後才生的 key 一定在輪換之後才到；
//     輪換之前就到的 key 不論日期都不能勝過它（存入順序是本機計數，不看任何時鐘）；
//   - 交來的裝置不在帳號上了，它交來的 key 一律不算（被撤裝置塞的 key，清單一更新就失效；回到清單上又算）；
//   - 回應 group_key_request 收到的 key（decrypt_only）只解密，不當錨點也不 active；之後以一般分發收到才照一般 key 算；
//   - 沒有交來裝置的舊資料列：照舊，維持原本的 active，出現錨點就停用（停用後不再回來）。
// 每把 key 到貨、自己輪換、帳號裝置清單更新時重算。

/** 帳號目前的裝置公鑰（最近一次成功抓到的清單）；null＝這次執行還沒抓到過 */
let accountDevices: ReadonlySet<string> | null = null;

/** group_keys 的寫入與重算排成一列：重算是「讀全部 → 寫回」，交錯執行會讓舊的結果蓋掉新的 */
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  writeChain = next.catch(() => undefined);
  return next;
}

function ownPublicKey(): string | null {
  try {
    return getPublicKeyBase64Sync();
  } catch {
    return null;   // 沒有 localStorage（單一模組測試）
  }
}

/** 誰比較新：createdAt，再比 keyId（同一毫秒也有固定答案） */
function isNewer(a: GroupKeyRecord, b: GroupKeyRecord): boolean {
  return a.createdAt !== b.createdAt ? a.createdAt > b.createdAt : a.keyId > b.keyId;
}

/**
 * 推導 active 的 keyId（純函式）。`counts`：交來這把 key 的裝置還算不算數（只問有交來裝置的資料列）。
 */
function deriveActiveKeyIds(
  keys: readonly GroupKeyRecord[],
  counts: (key: GroupKeyRecord) => boolean,
): Set<string> {
  let anchor: GroupKeyRecord | null = null;
  for (const key of keys) {
    if (key.distributor !== null && key.isRotation && !key.decryptOnly && counts(key) && (!anchor || isNewer(key, anchor))) anchor = key;
  }
  const active = new Set<string>();
  for (const key of keys) {
    if (key.decryptOnly) continue;   // 補發收到的：只解密
    if (key.distributor === null) {
      if (key.isActive && !anchor) active.add(key.keyId);
    } else if (key === anchor || (!key.isRotation && counts(key) && (!anchor || outlives(key, anchor)))) {
      active.add(key.keyId);
    }
  }
  return active;
}

/** 一般 key 在錨點之後還算數：比錨點新，而且在錨點之後才存進本機 */
function outlives(key: GroupKeyRecord, anchor: GroupKeyRecord): boolean {
  return isNewer(key, anchor) && (key.storedSeq ?? 0) > (anchor.storedSeq ?? 0);
}

/**
 * 依目前資料與裝置清單重算一個群組的 is_active（只在有變時寫回）。
 * `vouched`：剛確認仍是本帳號裝置的送方；只在這次執行還沒有清單時用（沒清單時其他列沿用上次重算的結果）。
 */
async function recomputeActiveKeys(groupId: string, vouched: string | null): Promise<void> {
  const keys = (await database.query(
    'SELECT * FROM group_keys WHERE group_id = ?',
    [groupId],
  )).map(rowToRecord);
  const self = ownPublicKey();
  const devices = accountDevices;
  const counts = (key: GroupKeyRecord) => key.distributor !== null && (key.distributor === self
    || (devices ? devices.has(key.distributor) : key.isActive || key.distributor === vouched));
  const active = deriveActiveKeyIds(keys, counts);
  if (keys.every((key) => key.isActive === active.has(key.keyId))) return;
  const ids = [...active];
  await database.run(
    ids.length > 0
      ? `UPDATE group_keys SET is_active = CASE WHEN key_id IN (${ids.map(() => '?').join(', ')}) THEN 1 ELSE 0 END WHERE group_id = ?`
      : 'UPDATE group_keys SET is_active = 0 WHERE group_id = ?',
    [...ids, groupId],
  );
}

/**
 * 帳號裝置清單（每次成功抓到；撤銷流程也用它給「剩下的裝置」）：交來的裝置不在清單上的 key 不再算 active，
 * 回到清單上的又算。空清單＝沒抓到（帳號至少有這台），不處理。不會丟錯（重算失敗下次清單再試）。
 */
export function observeAccountDevices(keys: readonly string[]): Promise<void> {
  const next: ReadonlySet<string> = new Set(keys.filter((key) => typeof key === 'string' && key.length > 0));
  if (next.size === 0) return Promise.resolve();
  return serialized(async () => {
    const previous = accountDevices;
    if (previous && previous.size === next.size && [...next].every((key) => previous.has(key))) return;
    accountDevices = next;
    try {
      const groups = await database.query<{ group_id: string }>('SELECT DISTINCT group_id FROM group_keys');
      for (const { group_id: groupId } of groups) await recomputeActiveKeys(groupId, null);
    } catch (err) {
      accountDevices = previous;
      console.warn('[groupKey] recompute after device list failed:', (err as Error)?.message ?? err);
    }
  });
}

// ============================================
// Ed25519 訊息簽名（ADR-016: 簽明文，防偽造）
// ============================================

/** Identity 簽名函式（由外部注入，避免循環依賴） */
type SignFn = (message: Uint8Array) => Uint8Array;
type VerifyFn = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;

let _signFn: SignFn | null = null;
let _verifyFn: VerifyFn | null = null;

/**
 * 註冊簽名函式（由 useCrypto 或 AppProvider 注入）
 */
export function registerSignFunctions(fns: { sign: SignFn; verify: VerifyFn }): void {
  _signFn = fns.sign;
  _verifyFn = fns.verify;
}

/**
 * 簽署明文（Ed25519）
 */
export function signPlaintext(plaintext: string): string {
  if (!_signFn) {
    console.error('[groupKey] Sign function not registered, returning empty signature');
    return '';
  }
  const data = new TextEncoder().encode(plaintext);
  const sig = _signFn(data);
  return bytesToBase64(sig);
}

/**
 * 驗證簽名（Ed25519）
 * @param senderPublicKeyBase64 - 發送者公鑰 (Base64)
 * @param plaintext - 原始明文
 * @param signatureBase64 - 簽名 (Base64)
 */
export function verifySignature(
  senderPublicKeyBase64: string,
  plaintext: string,
  signatureBase64: string,
): boolean {
  if (!_verifyFn || !signatureBase64) return false;

  try {
    const pubKey = base64ToBytes(senderPublicKeyBase64);
    const data = new TextEncoder().encode(plaintext);
    const sig = base64ToBytes(signatureBase64);
    return _verifyFn(pubKey, data, sig);
  } catch {
    return false;
  }
}

// ============================================
// 工具函式
// ============================================

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToRecord(row: any): GroupKeyRecord {
  return {
    groupId: row.group_id,
    keyId: row.key_id,
    keyBase64: row.key_base64,
    createdAt: row.created_at,
    createdBy: row.created_by,
    isActive: row.is_active === 1,
    expiresAt: row.expires_at,
    isRotation: row.is_rotation === 1,
    distributor: typeof row.distributor === 'string' ? row.distributor : null,
    storedSeq: typeof row.stored_seq === 'number' ? row.stored_seq : Number(row.stored_seq ?? 0),
    decryptOnly: Number(row.decrypt_only ?? 0) === 1,
  };
}
