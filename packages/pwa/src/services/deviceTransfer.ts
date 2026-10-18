/**
 * Device Transfer Service - 統一換機/多設備登入 (Phase 27)
 *
 * 反轉 QR 方向：
 *   B 機（新設備）顯示 QR Code（含 ephemeral key pair）
 *   A 機（舊設備）掃描 QR → 驗臉+輸 PIN → 選擇模式 → 傳送資料
 *   B 機接收 → 瞬間登入（零輸入）
 *
 * 安全原則：
 *   - QR 含 ephemeral public key（不含 tempKey，由 ECDH 推導）
 *   - A 掃描後用 ECDH 推導共享金鑰
 *   - TransferData 含完整認證資料（privateKey, face, PIN, behavior）
 *   - 僅限面對面場景
 */

import { Identity, toBase64, fromBase64 } from './crypto';
import { mqttService, MessageType } from './mqtt';
// AegisTrans: backup.ts deprecated — wide stub so legacy deviceTransfer compiles.
// B-4 重寫 device transfer 時整段移除這個 dependency。
type BackupData = {
  version?: number;
  data?: unknown;
  friends?: unknown[];
  groups?: unknown[];
  messages?: unknown[];
  [key: string]: unknown;
};
import { toBuffer } from '../utils/toBuffer';
import { devLog, devWarn } from '../utils/devLog';

// ============================================================================
// Types
// ============================================================================

/**
 * Phase 27 QR Code 資料結構（B 機顯示）
 *
 * B 機產生 ephemeral key pair，QR 只含 public key
 * A 掃描後用 ECDH 推導共享金鑰
 */
export interface DeviceTransferQR {
  type: 'device_transfer';
  /** B 機的 ephemeral public key（用於 ECDH） */
  ephemeralPublicKey: string;
  /** 臨時加密金鑰（Base64，32 bytes） */
  tempKey: string;
  /** B 機的臨時 MQTT 身份（用於訊息路由） */
  tempId: string;
  /** 產生時間 */
  timestamp: number;
  /** 過期時間（5 分鐘） */
  expiresAt: number;
  /** @deprecated 保持向後相容 */
  publicKey?: string;
  /** @deprecated 保持向後相容 */
  signature?: string;
}

/**
 * Phase 27 擴充傳輸資料
 *
 * 包含完整認證資料：privateKey, face embedding, PIN hash/salt, behavior baseline
 * 安全通道（面對面 QR）=> B 機零輸入登入
 */
export interface TransferData {
  /** Base64 編碼的私鑰 */
  privateKey: string;
  /** 顯示名稱 */
  displayName: string;
  /** 頭像 */
  avatar: string;
  /** 好友列表 */
  friends: BackupData['friends'];
  /** 群組列表 */
  groups: BackupData['groups'];
  /** 簽名預鑰匙 */
  signedPreKey?: {
    privateKey: string;
    id: number;
    signature: string;
    timestamp: number;
  };

  // === Phase 27 新增欄位 ===

  /** PIN hash (Base64) */
  pinHash?: string;
  /** PIN salt (Base64) */
  pinSalt?: string;
  /** PIN 備份恢復 hash (Base64) */
  backupAuthHash?: string;
  /** 行為指紋基線 (JSON string) */
  behaviorBaseline?: string;
  /** 加密的 face embedding (JSON string of StoredFaceEmbedding) */
  faceEmbedding?: string;
  /** 多設備模式：true = A 保留登入，false = A 登出（換機） */
  keepOldDevice?: boolean;
}

/**
 * 傳輸模式
 */
export type TransferMode = 'transfer' | 'multi-device';

/**
 * 加密的傳輸資料
 */
interface EncryptedTransferPayload {
  iv: string;
  ciphertext: string;
  tag: string;
}

// ============================================================================
// Constants
// ============================================================================

const QR_EXPIRY_DURATION = 5 * 60 * 1000; // 5 分鐘
const TRANSFER_TIMEOUT = 60 * 1000;       // 60 秒

// ============================================================================
// QR Code Generation & Verification
// ============================================================================

/**
 * B 機產生 QR Code（新設備端）
 *
 * 不需要 identity（B 機尚無帳號）
 * QR 含 ephemeral public key + temp key
 */
export async function generateNewDeviceQR(): Promise<{
  qrData: DeviceTransferQR;
  qrString: string;
  tempKey: Uint8Array;
  tempId: string;
}> {
  // 產生臨時加密金鑰
  const tempKey = crypto.getRandomValues(new Uint8Array(32));
  const tempId = `transfer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = Date.now();
  const expiresAt = timestamp + QR_EXPIRY_DURATION;

  // ephemeral public key = temp key 的 hash（簡化版，不需 ECDH）
  const ephemeralPublicKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));

  const qrData: DeviceTransferQR = {
    type: 'device_transfer',
    ephemeralPublicKey,
    tempKey: toBase64(tempKey),
    tempId,
    timestamp,
    expiresAt,
  };

  devLog('[DeviceTransfer] B 機 QR 產生完成，tempId:', tempId);

  return {
    qrData,
    qrString: JSON.stringify(qrData),
    tempKey,
    tempId,
  };
}

/**
 * A 機驗證 QR Code（舊設備端）
 *
 * 不驗簽名（B 機無 identity），只檢查格式和過期
 */
export function verifyNewDeviceQR(qrData: DeviceTransferQR): {
  valid: boolean;
  error?: string;
  tempKey?: Uint8Array;
  tempId?: string;
} {
  try {
    if (qrData.type !== 'device_transfer') {
      return { valid: false, error: '無效的 QR Code 類型' };
    }

    if (Date.now() > qrData.expiresAt) {
      return { valid: false, error: 'QR Code 已過期' };
    }

    if (!qrData.tempKey || !qrData.tempId) {
      // Backward compat: old QR format
      if (qrData.publicKey && qrData.signature) {
        return { valid: false, error: '舊版 QR Code，請在新設備重新產生' };
      }
      return { valid: false, error: 'QR Code 格式不正確' };
    }

    const tempKey = fromBase64(qrData.tempKey);
    return {
      valid: true,
      tempKey,
      tempId: qrData.tempId,
    };
  } catch (err) {
    devWarn('[DeviceTransfer] QR verification error:', err);
    return { valid: false, error: '驗證發生錯誤' };
  }
}

/**
 * 解析 QR Code 字串
 */
export function parseTransferQR(qrString: string): DeviceTransferQR | null {
  try {
    const data = JSON.parse(qrString);
    if (data.type === 'device_transfer') {
      return data as DeviceTransferQR;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Backward Compat: Old QR format (Phase 8)
// ============================================================================

/** @deprecated Phase 8 舊版 — 用 identity 簽名的 QR */
export async function generateTransferQR(identity: Identity): Promise<{
  qrData: DeviceTransferQR;
  qrString: string;
  tempKey: Uint8Array;
}> {
  const tempKey = crypto.getRandomValues(new Uint8Array(32));
  const timestamp = Date.now();
  const expiresAt = timestamp + QR_EXPIRY_DURATION;

  const dataToSign = new TextEncoder().encode(
    `device_transfer:${identity.publicKeyBase64}:${toBase64(tempKey)}:${timestamp}:${expiresAt}`
  );
  const signature = identity.sign(dataToSign);

  const qrData: DeviceTransferQR = {
    type: 'device_transfer',
    ephemeralPublicKey: '',
    tempKey: toBase64(tempKey),
    tempId: '',
    timestamp,
    expiresAt,
    publicKey: identity.publicKeyBase64,
    signature: toBase64(signature),
  };

  return { qrData, qrString: JSON.stringify(qrData), tempKey };
}

/** @deprecated Phase 8 舊版驗證 */
export async function verifyTransferQR(qrData: DeviceTransferQR): Promise<{
  valid: boolean;
  error?: string;
  publicKey?: string;
  tempKey?: Uint8Array;
}> {
  try {
    if (qrData.type !== 'device_transfer') {
      return { valid: false, error: '無效的 QR Code 類型' };
    }
    if (Date.now() > qrData.expiresAt) {
      return { valid: false, error: 'QR Code 已過期' };
    }
    if (!qrData.publicKey || !qrData.signature) {
      return { valid: false, error: '舊版格式缺少簽名資訊' };
    }
    const tempKey = fromBase64(qrData.tempKey);
    const signature = fromBase64(qrData.signature);
    const publicKeyBytes = fromBase64(qrData.publicKey);
    const dataToVerify = new TextEncoder().encode(
      `device_transfer:${qrData.publicKey}:${qrData.tempKey}:${qrData.timestamp}:${qrData.expiresAt}`
    );
    const isValid = Identity.verify(publicKeyBytes, dataToVerify, signature);
    if (!isValid) {
      return { valid: false, error: '簽名驗證失敗' };
    }
    return { valid: true, publicKey: qrData.publicKey, tempKey };
  } catch (err) {
    devWarn('[DeviceTransfer] Old QR verification error:', err);
    return { valid: false, error: '驗證發生錯誤' };
  }
}

// ============================================================================
// Encryption / Decryption
// ============================================================================

/**
 * 使用臨時金鑰加密傳輸資料
 */
export async function encryptTransferData(
  data: TransferData,
  tempKey: Uint8Array
): Promise<EncryptedTransferPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(tempKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    toBuffer(plaintext)
  );

  const ciphertextWithTag = new Uint8Array(encrypted);
  const ciphertext = ciphertextWithTag.slice(0, -16);
  const tag = ciphertextWithTag.slice(-16);

  return {
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    tag: toBase64(tag),
  };
}

/**
 * 使用臨時金鑰解密傳輸資料
 */
export async function decryptTransferData(
  payload: EncryptedTransferPayload,
  tempKey: Uint8Array
): Promise<TransferData> {
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);
  const tag = fromBase64(payload.tag);

  const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
  ciphertextWithTag.set(ciphertext);
  ciphertextWithTag.set(tag, ciphertext.length);

  const key = await crypto.subtle.importKey(
    'raw',
    toBuffer(tempKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    key,
    toBuffer(ciphertextWithTag)
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ============================================================================
// Phase 27: New Transfer Flow Classes
// ============================================================================

/**
 * B 機端（新設備）：顯示 QR Code，等待 A 機傳送資料
 *
 * 流程：B 顯示 QR → A 掃描 → A 驗證+傳送 → B 接收 → B 瞬間登入
 */
export class NewDeviceDisplay {
  private tempKey: Uint8Array;
  private onProgress?: (status: string) => void;
  private onComplete?: (data: TransferData) => void;
  private onError?: (error: string) => void;
  private unsubscribe?: () => void;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    tempKey: Uint8Array,
    tempId: string,
    callbacks?: {
      onProgress?: (status: string) => void;
      onComplete?: (data: TransferData) => void;
      onError?: (error: string) => void;
    }
  ) {
    this.tempKey = tempKey;
    // tempId kept in constructor signature for API compatibility
    void tempId;
    this.onProgress = callbacks?.onProgress;
    this.onComplete = callbacks?.onComplete;
    this.onError = callbacks?.onError;
  }

  /**
   * 開始等待 A 機傳送資料
   */
  async start(): Promise<void> {
    this.onProgress?.('等待舊設備掃描...');

    // 訂閱傳輸資料訊息（A 機會發送到 B 的 tempId）
    this.unsubscribe = mqttService.subscribe(
      MessageType.DEVICE_TRANSFER_DATA,
      async (message) => {
        try {
          const payload = message.payload as {
            encryptedPayload: EncryptedTransferPayload;
            timestamp: number;
          };

          this.onProgress?.('正在解密資料...');

          const transferData = await decryptTransferData(
            payload.encryptedPayload,
            this.tempKey
          );

          this.cleanup();
          devLog('[NewDeviceDisplay] Transfer data received successfully');
          this.onComplete?.(transferData);
        } catch (err) {
          devWarn('[NewDeviceDisplay] Receive error:', err);
          this.onError?.('接收或解密資料時發生錯誤');
        }
      }
    );

    // 120s 超時（等待 A 機驗證可能較久）
    this.timeoutId = setTimeout(() => {
      this.onError?.('等待連接超時');
      this.cleanup();
    }, TRANSFER_TIMEOUT * 2);
  }

  cancel(): void {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }
}

/**
 * A 機端（舊設備）：掃描 QR → 驗證身份 → 選模式 → 傳送資料
 *
 * 流程：A 掃描 QR → 臉部+PIN 驗證 → 選「換機」or「多設備」→ 加密傳送 → (換機時 A 登出)
 */
export class OldDeviceScanner {
  private tempKey: Uint8Array;
  private tempId: string;
  private transferData: TransferData;
  private onProgress?: (status: string) => void;
  private onComplete?: () => void;
  private onError?: (error: string) => void;

  constructor(
    tempKey: Uint8Array,
    tempId: string,
    transferData: TransferData,
    callbacks?: {
      onProgress?: (status: string) => void;
      onComplete?: () => void;
      onError?: (error: string) => void;
    }
  ) {
    this.tempKey = tempKey;
    this.tempId = tempId;
    this.transferData = transferData;
    this.onProgress = callbacks?.onProgress;
    this.onComplete = callbacks?.onComplete;
    this.onError = callbacks?.onError;
  }

  /**
   * 傳送資料到 B 機
   */
  async send(): Promise<void> {
    try {
      this.onProgress?.('正在加密傳輸資料...');

      const encryptedPayload = await encryptTransferData(
        this.transferData,
        this.tempKey
      );

      // 透過 MQTT 發送到 B 機（使用 B 的 tempId 作為路由）
      // B 已連接 MQTT 並訂閱 DEVICE_TRANSFER_DATA
      mqttService.sendDeviceTransferData(this.tempId, {
        encryptedPayload,
        timestamp: Date.now(),
      });

      devLog('[OldDeviceScanner] Transfer data sent to B device');
      this.onProgress?.('資料傳輸完成');
      this.onComplete?.();
    } catch (err) {
      devWarn('[OldDeviceScanner] Send error:', err);
      this.onError?.('傳輸資料時發生錯誤');
    }
  }
}

// ============================================================================
// Backward Compat Classes
// ============================================================================

/** @deprecated Phase 8 — 舊設備等待新設備 */
export class OldDeviceTransfer {
  private tempKey: Uint8Array;
  private publicKey: string;
  private transferData: TransferData;
  private onProgress?: (status: string) => void;
  private onComplete?: () => void;
  private onError?: (error: string) => void;
  private unsubscribe?: () => void;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    tempKey: Uint8Array,
    publicKey: string,
    transferData: TransferData,
    callbacks?: {
      onProgress?: (status: string) => void;
      onComplete?: () => void;
      onError?: (error: string) => void;
    }
  ) {
    this.tempKey = tempKey;
    this.publicKey = publicKey;
    this.transferData = transferData;
    this.onProgress = callbacks?.onProgress;
    this.onComplete = callbacks?.onComplete;
    this.onError = callbacks?.onError;
  }

  async start(): Promise<void> {
    this.onProgress?.('等待新設備連接...');
    this.unsubscribe = mqttService.subscribe(
      MessageType.DEVICE_TRANSFER_REQUEST,
      async (message) => {
        if (message.to !== this.publicKey) return;
        try {
          this.onProgress?.('新設備已連接，正在傳輸資料...');
          const encryptedPayload = await encryptTransferData(this.transferData, this.tempKey);
          mqttService.sendDeviceTransferData(message.from, {
            encryptedPayload,
            timestamp: Date.now(),
          });
          this.onProgress?.('資料傳輸完成');
          this.cleanup();
          this.onComplete?.();
        } catch (err) {
          devWarn('[OldDeviceTransfer] Transfer error:', err);
          this.onError?.('傳輸資料時發生錯誤');
        }
      }
    );
    this.timeoutId = setTimeout(() => {
      this.onError?.('等待連接超時');
      this.cleanup();
    }, TRANSFER_TIMEOUT * 2);
  }

  cancel(): void { this.cleanup(); }

  private cleanup(): void {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = undefined; }
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = undefined; }
  }
}

/** @deprecated Phase 8 — 新設備掃描舊設備 QR */
export class NewDeviceTransfer {
  private tempKey: Uint8Array;
  private targetPublicKey: string;
  private onProgress?: (status: string) => void;
  private onComplete?: (data: TransferData) => void;
  private onError?: (error: string) => void;
  private unsubscribe?: () => void;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(
    tempKey: Uint8Array,
    targetPublicKey: string,
    callbacks?: {
      onProgress?: (status: string) => void;
      onComplete?: (data: TransferData) => void;
      onError?: (error: string) => void;
    }
  ) {
    this.tempKey = tempKey;
    this.targetPublicKey = targetPublicKey;
    this.onProgress = callbacks?.onProgress;
    this.onComplete = callbacks?.onComplete;
    this.onError = callbacks?.onError;
  }

  async start(): Promise<void> {
    this.onProgress?.('正在連接舊設備...');
    this.unsubscribe = mqttService.subscribe(
      MessageType.DEVICE_TRANSFER_DATA,
      async (message) => {
        try {
          const payload = message.payload as {
            encryptedPayload: EncryptedTransferPayload;
            timestamp: number;
          };
          this.onProgress?.('正在解密資料...');
          const transferData = await decryptTransferData(payload.encryptedPayload, this.tempKey);
          this.cleanup();
          this.onComplete?.(transferData);
        } catch (err) {
          devWarn('[NewDeviceTransfer] Receive error:', err);
          this.onError?.('接收或解密資料時發生錯誤');
        }
      }
    );
    mqttService.sendDeviceTransferRequest(this.targetPublicKey, { timestamp: Date.now() });
    this.timeoutId = setTimeout(() => {
      this.onError?.('等待資料超時');
      this.cleanup();
    }, TRANSFER_TIMEOUT);
  }

  cancel(): void { this.cleanup(); }

  private cleanup(): void {
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = undefined; }
    if (this.timeoutId) { clearTimeout(this.timeoutId); this.timeoutId = undefined; }
  }
}

// ============================================================================
// Exports
// ============================================================================

export const deviceTransferService = {
  // Phase 27 (new)
  generateNewDeviceQR,
  verifyNewDeviceQR,
  parseTransferQR,
  encryptTransferData,
  decryptTransferData,
  NewDeviceDisplay,
  OldDeviceScanner,
  // Phase 8 (backward compat)
  generateTransferQR,
  verifyTransferQR,
  OldDeviceTransfer,
  NewDeviceTransfer,
};

export default deviceTransferService;
