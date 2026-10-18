/**
 * Device Pairing — 同帳號多裝置自動配對（AegisTrans-specific）
 *
 * AegisTalk 的「加好友」是手動：QR / invite code → INVITE_ACCEPT → X3DH。
 * AegisTrans 的「加好友」是自動：同帳號裝置自動視為已配對 group member，
 * 發現新 peer pubkey 就主動 PREKEY_REQUEST → 收 PRE_KEY_BUNDLE → X3DH initiator。
 *
 * 其餘 X3DH / Ratchet / Session 機制全部抄 AegisTalk（透過 useCrypto hook 注入）。
 *
 * 流程：
 *   A 登入 → identity ready → 開始監聽 MQTT
 *   A 發現 device list 有 B（從 backend devices API） → 對 B 發 PREKEY_REQUEST
 *   B 收到 PREKEY_REQUEST → 回 PRE_KEY_BUNDLE（payload.bundle = JSON string）
 *   A 收到 PRE_KEY_BUNDLE → 若還沒 session 就 createSession（X3DH initiator） → sendX3DHInit
 *   B 收到 X3DH_INIT → acceptSession（X3DH responder）
 *   兩邊都有 Session，可進入 group key dispatch / encrypt-decrypt 階段
 */

import { mqttService, MessageType, type MqttMessage } from './mqtt';
import { fromBase64, toBase64 } from './crypto';
import { devLog, devWarn } from '../utils/devLog';
import { wasInitAccepted, rememberAcceptedInit } from './x3dhReplay';
import { isConfirmedAccountDevice } from './accountDevices';

// ---------------------------------------------
// Crypto API 注入（避免非 React 服務直接耦合 hook）
// ---------------------------------------------
/** PRE_KEY_BUNDLE payload — 個別 base64 欄位（AegisTalk INVITE_ACCEPT 模式） */
interface PreKeyBundlePayload {
  signedPreKeyId: number;
  signedPreKeyPublic: string;
  signedPreKeySignature: string;
  signedPreKeyTimestamp: number;
  oneTimePreKeyId?: number;
  oneTimePreKeyPublic?: string;
}

interface CryptoAPI {
  getPreKeyBundleData: () => PreKeyBundlePayload | null;
  createSession: (
    recipientIdentityPublic: Uint8Array,
    recipientSignedPrekeyPublic: Uint8Array,
    recipientSignedPrekeySignature: Uint8Array,
    recipientOneTimePrekeyPublic?: Uint8Array,
    recipientOneTimePrekeyId?: number,
    forceFresh?: boolean
  ) => { ephemeralPublicKey: Uint8Array; usedOneTimePrekeyId?: number };
  acceptSession: (
    senderIdentityPublic: Uint8Array,
    senderEphemeralPublic: Uint8Array,
    usedOneTimePrekeyId?: number,
    forceReset?: boolean
  ) => unknown;
  hasSessionWith: (peerPubkeyBase64: string) => boolean;
  flushSessionWrites?: () => Promise<void>;
  /** X3DH 完成後（initiator / responder 兩端都會 fire）— 用來觸發 group key dispatch。 */
  onSessionEstablished?: (peerPubkeyBase64: string) => void;
}

/** 安全 send — MQTT 沒 ready 時不 throw（背景 retry 由上層 useEffect 觸發）。 */
function safeSendToUser(peerPk: string, type: MessageType, payload: unknown): boolean {
  try {
    mqttService.sendToUser(peerPk, type, payload);
    return true;
  } catch (err) {
    devWarn('[DevicePairing] sendToUser deferred (MQTT not ready):', (err as Error).message);
    return false;
  }
}

let crypto: CryptoAPI | null = null;
let unsubscribers: Array<() => void> = [];
let initialized = false;
let myPubkeyBase64: string | null = null;

export function registerCryptoFunctions(api: CryptoAPI, ownPubkeyBase64: string): void {
  crypto = api;
  myPubkeyBase64 = ownPubkeyBase64;
  devLog('[DevicePairing] Crypto functions registered');
}

export function unregisterCryptoFunctions(): void {
  crypto = null;
  myPubkeyBase64 = null;
  shutdownDevicePairing();
}

// ---------------------------------------------
// MQTT handlers — 抄 AegisTalk AppProvider 的 X3DH_INIT / PREKEY_REQUEST
// 邏輯，但去掉 friend list / profile update（AegisTrans 不需要）
// ---------------------------------------------

function setupX3DHInitHandler(): () => void {
  return mqttService.onMessage(MessageType.X3DH_INIT, async (message: MqttMessage) => {
    if (!crypto) return;
    try {
      const senderPubkeyBase64 = message.from;
      const payload = message.payload as {
        ephemeralPublicKey: string;
        senderName?: string;
        usedOneTimePrekeyId?: number;
        sessionReset?: boolean;
      };

      // 已不在帳號裝置清單（被撤銷）→ 不建 session（稽核 B1）：否則它能重新配對、拿到輪換後的新金鑰
      if (!(await isConfirmedAccountDevice(senderPubkeyBase64))) {
        devWarn('[DevicePairing] X3DH_INIT from a non-account device ignored:', senderPubkeyBase64.slice(0, 12) + '...');
        return;
      }
      if (!crypto) return;
      const owner = myPubkeyBase64;

      // 同一封 INIT 再到一次（broker QoS1 重投、App 被殺後重播）→ 不再交給 acceptSession（傳輸統一 X6）。
      //   acceptSession 的同 ephemeral 去重只在記憶體，重啟後失效 → 走 REPLACING／forceReset 把正常的
      //   session 拆掉重建。紀錄存 localStorage、跨重啟有效，必須在 acceptSession **之前**判斷。
      //   本機已經沒有 session 時照常處理：重新接受才救得回來。
      if (owner && crypto.hasSessionWith(senderPubkeyBase64)
          && wasInitAccepted(owner, senderPubkeyBase64, payload.ephemeralPublicKey)) {
        devLog('[DevicePairing] duplicate X3DH_INIT (ephemeral already accepted) → ignore', senderPubkeyBase64.slice(0, 12) + '...');
        return;
      }

      // Idempotent — useCrypto.acceptSession 內部已防重（記憶體，同一次執行內有效）
      const senderIdentityPublic = fromBase64(senderPubkeyBase64);
      const senderEphemeralPublic = fromBase64(payload.ephemeralPublicKey);
      crypto.acceptSession(
        senderIdentityPublic,
        senderEphemeralPublic,
        payload.usedOneTimePrekeyId,
        payload.sessionReset === true
      );
      await crypto.flushSessionWrites?.();
      // session 落 DB 之後才記：之後同一封再到就不再碰 session（含 glare 保留我方 session 的情況）
      if (owner) rememberAcceptedInit(owner, senderPubkeyBase64, payload.ephemeralPublicKey);
      devLog('[DevicePairing] X3DH_INIT accepted from:', senderPubkeyBase64.slice(0, 12) + '...');
      crypto.onSessionEstablished?.(senderPubkeyBase64);
    } catch (err) {
      console.error('[DevicePairing] X3DH_INIT handler failed:', err);
    }
  });
}

function setupPreKeyRequestHandler(): () => void {
  return mqttService.onMessage(MessageType.PREKEY_REQUEST, async (message: MqttMessage) => {
    if (!crypto) return;
    try {
      const requesterPubkey = message.from;
      const payload = message.payload as { sessionReset?: boolean } | undefined;
      // 已不在帳號裝置清單（被撤銷）→ 不給 bundle（稽核 B1）
      if (!(await isConfirmedAccountDevice(requesterPubkey))) {
        devWarn('[DevicePairing] PREKEY_REQUEST from a non-account device ignored:', requesterPubkey.slice(0, 12) + '...');
        return;
      }
      if (!crypto) return;
      const data = crypto.getPreKeyBundleData();
      if (!data) {
        devWarn('[DevicePairing] PREKEY_REQUEST: bundle not ready, ignoring');
        return;
      }
      safeSendToUser(requesterPubkey, MessageType.PRE_KEY_BUNDLE, {
        ...data,
        sessionReset: payload?.sessionReset === true,
      });
      devLog('[DevicePairing] PRE_KEY_BUNDLE sent to:', requesterPubkey.slice(0, 12) + '...');
    } catch (err) {
      console.error('[DevicePairing] PREKEY_REQUEST handler failed:', err);
    }
  });
}

function setupPreKeyBundleHandler(): () => void {
  return mqttService.onMessage(MessageType.PRE_KEY_BUNDLE, async (message: MqttMessage) => {
    if (!crypto) return;
    try {
      const senderPubkey = message.from;
      const data = message.payload as PreKeyBundlePayload & { sessionReset?: boolean };
      if (!data || !data.signedPreKeyPublic || !data.signedPreKeySignature) {
        devWarn('[DevicePairing] PRE_KEY_BUNDLE: malformed payload from', senderPubkey.slice(0, 12));
        return;
      }
      // 已不在帳號裝置清單（被撤銷）→ 不建 session（稽核 B1）
      if (!(await isConfirmedAccountDevice(senderPubkey))) {
        devWarn('[DevicePairing] PRE_KEY_BUNDLE from a non-account device ignored:', senderPubkey.slice(0, 12) + '...');
        return;
      }
      if (!crypto) return;

      // 已配對就跳過（避免 ratchet reset）；explicit reset 例外，必須建 fresh Alice。
      const forceReset = data.sessionReset === true;
      if (crypto.hasSessionWith(senderPubkey) && !forceReset) {
        devLog('[DevicePairing] PRE_KEY_BUNDLE: session already exists with', senderPubkey.slice(0, 12) + '...');
        return;
      }

      // sender 的 identity pubkey 用 message.from（broker ACL 只限帳號內，不驗證是哪台；上面已確認仍是帳號裝置）
      const recipientIdentityPublic = fromBase64(senderPubkey);
      const recipientSignedPrekeyPublic = fromBase64(data.signedPreKeyPublic);
      const recipientSignedPrekeySignature = fromBase64(data.signedPreKeySignature);
      const recipientOTPPublic = data.oneTimePreKeyPublic
        ? fromBase64(data.oneTimePreKeyPublic)
        : undefined;
      const recipientOTPId = data.oneTimePreKeyId;

      const { ephemeralPublicKey, usedOneTimePrekeyId } = crypto.createSession(
        recipientIdentityPublic,
        recipientSignedPrekeyPublic,
        recipientSignedPrekeySignature,
        recipientOTPPublic,
        recipientOTPId,
        forceReset
      );
      await crypto.flushSessionWrites?.();

      // 通知對方：我已建立 session，開始 ratchet
      safeSendToUser(senderPubkey, MessageType.X3DH_INIT, {
        ephemeralPublicKey: toBase64(ephemeralPublicKey),
        usedOneTimePrekeyId,
        sessionReset: forceReset,
      });
      devLog('[DevicePairing] X3DH initiated with:', senderPubkey.slice(0, 12) + '...');
      crypto.onSessionEstablished?.(senderPubkey);
    } catch (err) {
      console.error('[DevicePairing] PRE_KEY_BUNDLE handler failed:', err);
    }
  });
}

// ---------------------------------------------
// 主動配對：對 peer 發 PREKEY_REQUEST
// ---------------------------------------------

/**
 * 對指定的 peer 發起配對。idempotent — 已有 session 就跳過。
 * 通常在 device list 變化 / WebRTC peer 連上後呼叫。
 *
 * Both sides may request when they are missing a session. If they do so at the
 * same time, useCrypto's X3DH glare tiebreak converges to one Alice/one Bob.
 */
export function requestPairingWith(peerPubkeyBase64: string): void {
  if (!crypto || !myPubkeyBase64) {
    devWarn('[DevicePairing] requestPairingWith: crypto not registered');
    return;
  }
  if (crypto.hasSessionWith(peerPubkeyBase64)) {
    return;
  }
  if (safeSendToUser(peerPubkeyBase64, MessageType.PREKEY_REQUEST, {})) {
    devLog('[DevicePairing] PREKEY_REQUEST sent to:', peerPubkeyBase64.slice(0, 12) + '...');
  }
}

/**
 * 對一批 peers 發起配對。
 */
export function requestPairingWithMany(peerPubkeys: string[]): void {
  peerPubkeys.forEach(requestPairingWith);
}

/**
 * 偵測到與 peer 的 ratchet 壞掉(persistent aead)時的自癒：發 PREKEY_REQUEST{sessionReset:true}。
 * 對方回 PRE_KEY_BUNDLE{sessionReset} → 我方 createSession(forceFresh)=新 Alice → X3DH_INIT{sessionReset}
 * → 對方 acceptSession(forceReset)=新 Bob。雙邊全新 session;接著兩邊 onSessionEstablished → 各自重新
 * dispatch group key → 自動恢復,免使用者重登。**不**因 hasSessionWith 早退(就是要換掉壞掉的舊 session)。
 */
export function requestRepairWith(peerPubkeyBase64: string): void {
  if (!crypto || !myPubkeyBase64) {
    devWarn('[DevicePairing] requestRepairWith: crypto not registered');
    return;
  }
  if (safeSendToUser(peerPubkeyBase64, MessageType.PREKEY_REQUEST, { sessionReset: true })) {
    devLog('[DevicePairing] repair PREKEY_REQUEST(sessionReset) ->', peerPubkeyBase64.slice(0, 12) + '...');
  }
}

// ---------------------------------------------
// Lifecycle
// ---------------------------------------------

export function initDevicePairing(): void {
  if (initialized) return;
  unsubscribers = [
    setupX3DHInitHandler(),
    setupPreKeyRequestHandler(),
    setupPreKeyBundleHandler(),
  ];
  initialized = true;
  devLog('[DevicePairing] Initialized — listening for PREKEY_REQUEST / PRE_KEY_BUNDLE / X3DH_INIT');
}

export function shutdownDevicePairing(): void {
  unsubscribers.forEach((u) => { try { u(); } catch { /* ignore */ } });
  unsubscribers = [];
  initialized = false;
  devLog('[DevicePairing] Shutdown');
}
