/**
 * Group Key Envelope helpers — 共用的「JSON envelope ↔ Group Key (AES-256-GCM)」轉換
 *
 * 集中所有 wire-level kind:
 *   - encrypted_text         → Message
 *   - encrypted_delete       → { messageId }
 *   - encrypted_file_request → { fileId }
 *   - encrypted_file_manifest → FileManifestEnvelope
 *
 * peerSync.ts 跟 fileTransfer.ts 都從這裡 import；避免兩邊各自寫一份加密 envelope 邏輯
 * 走 drift（之前 fileTransfer.sendFile 直接 inline 一份 manifest 加密 — 跟 peerSync
 * 的 buildEncryptedEnvelope 沒共用，加密格式改動很容易兩邊出現不一致）。
 *
 * Chunk frame 不在這裡 — 它需要 keyId/iv 在 binary header 裡走 raw bytes 加密，
 * 不適用 JSON envelope；保留在 fileTransfer.ts。
 */

import * as groupKeyService from './groupKey';
import { myDevicesGroupId, ensureMyDevicesGroupKey } from './myDevicesGroup';
import { devWarn } from '../utils/devLog';

export const ENVELOPE_PROTOCOL_VERSION = 1;

export type EncryptedEnvelopeKind =
  | 'encrypted_text'
  | 'encrypted_delete'
  | 'encrypted_file_request'
  | 'encrypted_file_manifest';

export interface EncryptedEnvelope {
  v: number;
  kind: EncryptedEnvelopeKind;
  keyId: string;
  iv: string;          // base64
  ciphertext: string;  // base64
}

/**
 * 用當前 active group key 加密 JSON-serializable inner，回傳 wire-format JSON 字串。
 * 沒 active key（bootstrap race） / 加密失敗 → null（caller 自己決定 fallback 策略）。
 */
export async function buildEncryptedEnvelope(
  userId: string,
  kind: EncryptedEnvelopeKind,
  inner: object,
): Promise<string | null> {
  try {
    const groupId = myDevicesGroupId(userId);
    const activeKey = await groupKeyService.getActiveGroupKey(groupId);
    if (!activeKey) {
      devWarn(`[GroupKeyEnvelope] ${kind}: no active group key`);
      return null;
    }
    return await encryptInnerWithKey(kind, inner, activeKey.keyId, activeKey.keyBase64);
  } catch (err) {
    devWarn(`[GroupKeyEnvelope] ${kind}: encryption failed:`, (err as Error).message);
    return null;
  }
}

/**
 * Like buildEncryptedEnvelope but if no active key exists, generate one first
 * **iff self is dispatcher**（lex-smaller than all peers）or no peers exist。
 *
 * 為何不無條件 generate（舊行為）：non-dispatcher 也 generate 會造成「兩邊各生一把
 * 自己的 key 互相加密 → 對方都解不出來」的真實 bug（2026-05-06 user report）。
 * 正確流程：dispatcher 生 key 並透過 X3DH 寄給 non-dispatcher，後者收到才能 send。
 *
 * 沒 key 又非 dispatcher → throw，呼叫端應 queue / retry。
 *
 * 加密失敗時 throw — 絕不 fallback 到明文 envelope。
 */
export async function buildEncryptedEnvelopeOrGenerate(
  userId: string,
  ownPubkeyBase64: string,
  kind: EncryptedEnvelopeKind,
  inner: object,
  peerPubkeys?: string[],
): Promise<string> {
  const groupId = myDevicesGroupId(userId);
  let activeKey = await groupKeyService.getActiveGroupKey(groupId);
  if (!activeKey) {
    // 沒 active key 一律自己生並用。原 tiebreaker(只 lex-smaller dispatcher 才能 generate)
    // 在 dispatcher 離線時讓全 group 卡死。改成:每個裝置自生 key,X3DH session 建立
    // 後雙邊都 dispatch 給對方。雙方 keystore 各保留多把 key,decrypt 時用 keyId 找對應。
    // 重複/race 由 handleKeyDistribution 用 keyId 去重。
    void peerPubkeys;
    activeKey = await ensureMyDevicesGroupKey(userId, ownPubkeyBase64);
  }
  return encryptInnerWithKey(kind, inner, activeKey.keyId, activeKey.keyBase64);
}

/**
 * 解 envelope。看 keyId 找 key → 解密 → JSON.parse。
 * 缺欄位 / 找不到 key / 解密失敗 → null。
 */
export async function decryptEnvelope<T>(envelope: {
  keyId?: string;
  ciphertext?: string;
  iv?: string;
}): Promise<T | null> {
  if (!envelope.keyId || !envelope.ciphertext || !envelope.iv) return null;
  try {
    const keyRecord = await groupKeyService.getGroupKeyById(envelope.keyId);
    if (!keyRecord) {
      devWarn('[GroupKeyEnvelope] No group key for keyId:', envelope.keyId);
      return null;
    }
    const plaintext = await groupKeyService.decryptWithGroupKey(
      envelope.ciphertext,
      envelope.iv,
      keyRecord.keyBase64,
    );
    return JSON.parse(plaintext) as T;
  } catch (err) {
    devWarn('[GroupKeyEnvelope] decrypt failed:', (err as Error).message);
    return null;
  }
}

async function encryptInnerWithKey(
  kind: EncryptedEnvelopeKind,
  inner: object,
  keyId: string,
  keyBase64: string,
): Promise<string> {
  const { ciphertext, iv } = await groupKeyService.encryptWithGroupKey(
    JSON.stringify(inner),
    keyBase64,
  );
  const envelope: EncryptedEnvelope = {
    v: ENVELOPE_PROTOCOL_VERSION,
    kind,
    keyId,
    iv,
    ciphertext,
  };
  return JSON.stringify(envelope);
}
