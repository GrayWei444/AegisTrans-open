/**
 * My Devices Group — 同帳號多裝置共享 Group Key（AegisTrans-specific）
 *
 * AegisTalk 的 Group Key 服務於多人群組；AegisTrans 把「同帳號所有裝置」視為
 * 一個固定 group（`aegistrans:${userId}:my-devices`），用同一把 AES-256-GCM
 * Group Key 加密所有跨裝置訊息。
 *
 * 流程：
 *   1. App 啟動 → ensureMyDevicesGroupKey(userId, ownPubkey)
 *      - 已有 active key → 直接用
 *      - 沒有 → 生新 key、saveGroupKey
 *   2. devicePairing 完成 X3DH → dispatchGroupKeyTo(peerPk, encrypt)
 *      - 取 active key → createKeyDistribution → encrypt(peerPk, JSON)
 *      - 走 MQTT ENCRYPTED_MESSAGE 發給對方（一定送得到 — broker 會緩存）
 *   3. 對方收到 ENCRYPTED_MESSAGE → decrypt → JSON.parse
 *      - 若 type === 'group_key_distribution' → handleKeyDistribution
 *
 * Race-safe note：dispatchGroupKeyTo 用 setTimeout(0) 延遲到下個 tick 才送，
 * 確保 X3DH/Ratchet 持久化完成（saveSession 是 async，devicePairing 收到
 * X3DH_INIT 同步呼叫 acceptSession 後就回，DB 寫入可能還在進行）。
 */

import { mqttService, MessageType } from './mqtt';
import * as groupKeyService from './groupKey';
import { devLog, devWarn } from '../utils/devLog';
import type { RatchetMessage } from './crypto';

/** 同帳號裝置 group id；deterministic by userId。 */
export function myDevicesGroupId(userId: string): string {
  return `aegistrans:${userId}:my-devices`;
}

// 暴露給 e2e test：查詢當前 active group key id（CR-06/H-07：release build 不曝露）
import { DEBUG_TOOLS } from '../utils/debugFlags';
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error
  window.__aegisDebug.activeGroupKey = async (userId: string) => {
    const key = await groupKeyService.getActiveGroupKey(myDevicesGroupId(userId));
    return key ? { keyId: key.keyId, createdAt: key.createdAt, isActive: key.isActive } : null;
  };
}

/** Encrypt 函式型別（從 useCrypto 注入；避免循環依賴 React hook） */
type EncryptFn = (peerPk: string, plaintext: string) => Promise<RatchetMessage>;

/**
 * 確保本機有 active group key。如沒有就生新的。
 * Idempotent — race condition 下可能多裝置同時生 key，最終會收斂（先收到誰的就用誰的）。
 */
export async function ensureMyDevicesGroupKey(
  userId: string,
  ownPubkeyBase64: string,
): Promise<groupKeyService.GroupKeyRecord> {
  // 查、生、存、重算在 groupKey 的寫入佇列裡一次做完（審查 LOW-6：跟重算交錯時新 key 會被寫成不 active）
  const { key, created } = await groupKeyService.ensureActiveGroupKey(myDevicesGroupId(userId), ownPubkeyBase64);
  devLog(created ? '[MyDevicesGroup] Generated new group key:' : '[MyDevicesGroup] Active key found:', key.keyId);
  return key;
}

/**
 * 撤銷裝置時呼叫（先用 groupKey.observeAccountDevices 給剩下的裝置清單）：
 *   1. rotateGroupKey → 生新的輪換 key，成為 active 集合的錨點，比它舊的都停用
 *   2. 把新 key 透過 1-1 Ratchet 加密後 dispatch 給「剩餘」每個裝置（不送給被撤的）
 *
 * 被撤的裝置因為沒收到新 key，無法解密之後內容。舊 key 保留於本機（72 小時雙發
 * 期）讓還沒處理完的舊 ciphertext 仍可解。
 */
export async function rotateGroupKeyAndDispatch(
  userId: string,
  ownPubkeyBase64: string,
  remainingPeerPubkeys: string[],
  encrypt: EncryptFn,
): Promise<void> {
  const groupId = myDevicesGroupId(userId);
  const result = await groupKeyService.rotateGroupKey(groupId, ownPubkeyBase64);
  devLog(`[MyDevicesGroup] rotated group key ${result.oldKey?.keyId ?? '<none>'} -> ${result.newKey.keyId}, dispatching to ${remainingPeerPubkeys.length} peers`);

  for (const peer of remainingPeerPubkeys) {
    setTimeout(async () => {
      try {
        // isRotation:true → 收端把它當錨點，比它舊的 key 都停用（以前送 false，收端繼續用被撤裝置也有的舊 key，稽核 B11）
        const dist = groupKeyService.createKeyDistribution(result.newKey, true);
        const encrypted = await encrypt(peer, JSON.stringify(dist));
        mqttService.sendToUser(peer, MessageType.ENCRYPTED_MESSAGE, encrypted.toJson());
        devLog('[MyDevicesGroup] Rotated key dispatched to:', peer.slice(0, 12) + '...');
      } catch (err) {
        devWarn('[MyDevicesGroup] rotated key dispatch failed for', peer.slice(0, 12), ':', (err as Error).message);
      }
    }, 0);
  }
}

/** 向訊息 sender 要指定 keyId；用 1-1 Ratchet，不依賴缺失的 group key。 */
export async function requestGroupKeyFrom(
  userId: string,
  peerPubkeyBase64: string,
  keyId: string,
  encrypt: EncryptFn,
): Promise<void> {
  const req: groupKeyService.GroupKeyRequest = {
    type: 'group_key_request',
    groupId: myDevicesGroupId(userId),
    keyId,
    requestedAt: Date.now(),
  };
  const encrypted = await encrypt(peerPubkeyBase64, JSON.stringify(req));
  mqttService.sendToUser(peerPubkeyBase64, MessageType.ENCRYPTED_MESSAGE, encrypted.toJson());
  devLog('[MyDevicesGroup] Requested group key from:', peerPubkeyBase64.slice(0, 12) + '...', 'keyId:', keyId);
}

/**
 * 回覆缺 key request：只補發本機已存在且屬於「我的裝置」group 的那把 key。
 * 不產生新 key，避免把 recovery path 變成隱式 rotation/generation。
 * 標成 decryptOnly：收方只拿來解那則訊息，不會設成 active（審查 LOW-1：補發的可以是任何存著的 key，包括被撤的
 * 裝置撤銷前塞來、這台已經不用的 key）。
 */
export async function dispatchGroupKeyByIdTo(
  userId: string,
  keyId: string,
  peerPubkeyBase64: string,
  encrypt: EncryptFn,
): Promise<boolean> {
  const key = await groupKeyService.getGroupKeyById(keyId);
  if (!key || key.groupId !== myDevicesGroupId(userId)) {
    devWarn('[MyDevicesGroup] Cannot satisfy group key request; missing/non-local keyId:', keyId);
    return false;
  }
  const dist: groupKeyService.GroupKeyDistribution = { ...groupKeyService.createKeyDistribution(key, false), decryptOnly: true };
  const encrypted = await encrypt(peerPubkeyBase64, JSON.stringify(dist));
  mqttService.sendToUser(peerPubkeyBase64, MessageType.ENCRYPTED_MESSAGE, encrypted.toJson());
  devLog('[MyDevicesGroup] Re-dispatched requested group key to:', peerPubkeyBase64.slice(0, 12) + '...', 'keyId:', keyId);
  return true;
}

/**
 * 把當前 active group key 透過 1-1 Ratchet 加密後 dispatch 給對方。
 * 用 MQTT ENCRYPTED_MESSAGE（reliable — broker 緩存到對方上線）。
 *
 * 排到下個 tick 執行，避免 X3DH 完成同 tick 就送 → Ratchet state 還沒落 DB。
 *
 * 只有 dispatcher（lex-smaller pubkey）會呼叫此函式 — 在這裡 ensure key 可避免
 * 雙邊 race 各自先建一把 key 互相覆蓋。
 */
export function dispatchGroupKeyTo(
  userId: string,
  peerPubkeyBase64: string,
  ownPubkeyBase64: string,
  encrypt: EncryptFn,
): void {
  setTimeout(async () => {
    try {
      // dispatcher 才在這裡生 key — 避免雙邊 ensureMyDevicesGroupKey race
      const activeKey = await ensureMyDevicesGroupKey(userId, ownPubkeyBase64);
      const dist = groupKeyService.createKeyDistribution(activeKey, false);
      const encrypted = await encrypt(peerPubkeyBase64, JSON.stringify(dist));
      try {
        mqttService.sendToUser(peerPubkeyBase64, MessageType.ENCRYPTED_MESSAGE, encrypted.toJson());
        devLog('[MyDevicesGroup] Dispatched group key to:', peerPubkeyBase64.slice(0, 12) + '...', 'keyId:', activeKey.keyId);
      } catch (err) {
        devWarn('[MyDevicesGroup] sendToUser failed (MQTT not ready?):', (err as Error).message);
      }
    } catch (err) {
      console.error('[MyDevicesGroup] dispatchGroupKeyTo failed:', err);
    }
  }, 0);
}
