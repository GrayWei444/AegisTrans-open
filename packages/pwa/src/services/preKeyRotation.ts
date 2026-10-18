import { devLog } from '../utils/devLog';

/**
 * PreKey Rotation Service - 預金鑰輪換管理
 *
 * E2EE Phase 3 改善：自動化 PreKey 生命週期管理
 *
 * 設計原則：
 * - SignedPreKey: 建議每 30 天輪換一次
 * - OneTimePreKey: 當剩餘數量低於閾值時自動補充
 * - 輪換時機：應用啟動時檢查 + 定期背景檢查
 *
 * 安全考量：
 * - 舊 PreKey 在過渡期間保留，確保進行中的會話不中斷
 * - PreKey 使用後標記為已用，避免重複使用
 * - 儲存 PreKey 建立時間用於輪換決策
 */

import { SignedPreKey, OneTimePreKey, Identity, toBase64, fromBase64 } from './crypto';

// ============================================
// 類型定義
// ============================================

/**
 * PreKey 狀態
 */
export interface PreKeyStatus {
  // SignedPreKey 狀態
  signedPreKey: {
    id: number;
    createdAt: number;
    ageInDays: number;
    needsRotation: boolean;
    publicKeyBase64: string;
  };
  // OneTimePreKey 狀態
  oneTimePreKeys: {
    total: number;
    available: number;
    used: number;
    needsReplenishment: boolean;
    threshold: number;
  };
  // 上次檢查時間
  lastChecked: number;
  // 整體健康狀態
  healthy: boolean;
}

/**
 * 儲存的 SignedPreKey 資料
 */
interface StoredSignedPreKey {
  id: number;
  publicKey: string;  // Base64
  privateKey: string; // Base64
  signature: string;  // Base64
  createdAt: number;
  rotatedAt?: number; // 輪換時間（舊金鑰）
}

/**
 * 儲存的 OneTimePreKey 資料
 */
interface StoredOneTimePreKey {
  id: number;
  publicKey: string;  // Base64
  privateKey: string; // Base64
  createdAt: number;
  usedAt?: number;    // 使用時間
}

/**
 * PreKey 儲存結構
 */
interface PreKeyStore {
  // 當前 SignedPreKey
  currentSignedPreKey: StoredSignedPreKey | null;
  // 舊的 SignedPreKey（過渡期間保留）
  previousSignedPreKeys: StoredSignedPreKey[];
  // OneTimePreKey 列表
  oneTimePreKeys: StoredOneTimePreKey[];
  // 下一個 OneTimePreKey ID
  nextOneTimePreKeyId: number;
  // 下一個 SignedPreKey ID
  nextSignedPreKeyId: number;
}

/**
 * 輪換事件回調
 */
export type RotationCallback = (event: {
  type: 'signed' | 'onetime';
  oldKeyId?: number;
  newKeyId: number;
  timestamp: number;
}) => void;

// ============================================
// 常數配置
// ============================================

const CONFIG = {
  // SignedPreKey 輪換週期（天）
  SIGNED_PREKEY_ROTATION_DAYS: 30,
  // SignedPreKey 保留期限（天）- 舊金鑰保留以處理進行中的會話
  SIGNED_PREKEY_RETENTION_DAYS: 7,
  // OneTimePreKey 最小數量
  ONETIME_PREKEY_MIN_COUNT: 10,
  // OneTimePreKey 補充批量
  ONETIME_PREKEY_BATCH_SIZE: 20,
  // OneTimePreKey 最大數量
  ONETIME_PREKEY_MAX_COUNT: 100,
  // 背景檢查間隔（毫秒）
  CHECK_INTERVAL: 60 * 60 * 1000, // 1 小時
};

// 儲存鍵名
const STORAGE_KEY = 'aegistrans_prekey_store';

// ============================================
// PreKey 輪換服務
// ============================================

class PreKeyRotationService {
  private store: PreKeyStore | null = null;
  private identity: Identity | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private rotationCallbacks: Set<RotationCallback> = new Set();

  /**
   * 初始化服務
   * @param identity - 用戶身份金鑰（用於簽署 PreKey）
   */
  async initialize(identity: Identity): Promise<void> {
    this.identity = identity;
    this.store = this.loadStore();

    // 如果沒有 SignedPreKey，初始化
    if (!this.store.currentSignedPreKey) {
      await this.generateInitialKeys();
    }

    // 啟動時檢查
    await this.checkAndRotate();

    // 設定定期檢查
    this.startPeriodicCheck();

    devLog('[PreKeyRotation] Initialized');
  }

  /**
   * Migration helper（Phase 1 收尾項目 D）：從 useCrypto 既有 state 種子化 store。
   *
   * 用於：原本 useCrypto 自己管 SPK + OTPs（aegistrans_keys），現在改成 service
   * 統一管。對「fork 後已 dogfood 過、已有 X3DH session」的 user，必須把 useCrypto
   * 用的 SPK + OTPs 同步到 service store，否則 service.initialize 會生新 keys → 跟對
   * 端建立的 ratchet session 對不上 → X3DH responder lookup 拿到錯的 OTP 解出來
   * sharedSecret 不對 → aead::Error。
   *
   * Idempotent — 只要 store 已有 currentSignedPreKey 就跳過（重複呼叫安全）。
   */
  async seedFromUseCrypto(
    identity: Identity,
    spk: SignedPreKey,
    otps: OneTimePreKey[],
  ): Promise<void> {
    this.identity = identity;
    this.store = this.loadStore();
    if (this.store.currentSignedPreKey) {
      devLog('[PreKeyRotation] seedFromUseCrypto skipped — store already populated');
      return;
    }
    this.store.currentSignedPreKey = {
      id: spk.id,
      publicKey: spk.publicKeyBase64,
      privateKey: toBase64(spk.privateKey),
      signature: toBase64(spk.signature),
      createdAt: spk.timestamp,
    };
    this.store.nextSignedPreKeyId = spk.id + 1;
    this.store.oneTimePreKeys = otps.map((otp) => ({
      id: otp.id,
      publicKey: otp.publicKeyBase64,
      privateKey: toBase64(otp.privateKey),
      createdAt: spk.timestamp,
    }));
    const maxOtpId = otps.reduce((m, o) => Math.max(m, o.id), 0);
    this.store.nextOneTimePreKeyId = maxOtpId + 1;
    this.saveStore();
    devLog(`[PreKeyRotation] seedFromUseCrypto: SPK id=${spk.id}, ${otps.length} OTPs`);
  }

  /**
   * 關閉服務
   */
  shutdown(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    devLog('[PreKeyRotation] Shutdown');
  }

  /**
   * 取得當前 PreKey 狀態
   */
  getStatus(): PreKeyStatus {
    if (!this.store || !this.store.currentSignedPreKey) {
      return {
        signedPreKey: {
          id: 0,
          createdAt: 0,
          ageInDays: 0,
          needsRotation: true,
          publicKeyBase64: '',
        },
        oneTimePreKeys: {
          total: 0,
          available: 0,
          used: 0,
          needsReplenishment: true,
          threshold: CONFIG.ONETIME_PREKEY_MIN_COUNT,
        },
        lastChecked: 0,
        healthy: false,
      };
    }

    const now = Date.now();
    const signedPreKeyAge = now - this.store.currentSignedPreKey.createdAt;
    const ageInDays = Math.floor(signedPreKeyAge / (24 * 60 * 60 * 1000));
    const needsRotation = ageInDays >= CONFIG.SIGNED_PREKEY_ROTATION_DAYS;

    const availableOneTimeKeys = this.store.oneTimePreKeys.filter(k => !k.usedAt);
    const usedOneTimeKeys = this.store.oneTimePreKeys.filter(k => k.usedAt);
    const needsReplenishment = availableOneTimeKeys.length < CONFIG.ONETIME_PREKEY_MIN_COUNT;

    return {
      signedPreKey: {
        id: this.store.currentSignedPreKey.id,
        createdAt: this.store.currentSignedPreKey.createdAt,
        ageInDays,
        needsRotation,
        publicKeyBase64: this.store.currentSignedPreKey.publicKey,
      },
      oneTimePreKeys: {
        total: this.store.oneTimePreKeys.length,
        available: availableOneTimeKeys.length,
        used: usedOneTimeKeys.length,
        needsReplenishment,
        threshold: CONFIG.ONETIME_PREKEY_MIN_COUNT,
      },
      lastChecked: now,
      healthy: !needsRotation && !needsReplenishment,
    };
  }

  /**
   * 取得當前 SignedPreKey
   */
  getCurrentSignedPreKey(): SignedPreKey | null {
    if (!this.store?.currentSignedPreKey || !this.identity) {
      return null;
    }

    const stored = this.store.currentSignedPreKey;
    return SignedPreKey.fromPrivateKey(
      fromBase64(stored.privateKey),
      stored.id,
      fromBase64(stored.signature),
      stored.createdAt
    );
  }

  /**
   * 取得可用的 OneTimePreKey
   */
  getAvailableOneTimePreKey(): OneTimePreKey | null {
    if (!this.store) {
      return null;
    }

    const available = this.store.oneTimePreKeys.find(k => !k.usedAt);
    if (!available) {
      return null;
    }

    return OneTimePreKey.fromPrivateKey(
      fromBase64(available.privateKey),
      available.id
    );
  }

  /**
   * 標記 OneTimePreKey 為已使用
   */
  markOneTimePreKeyUsed(keyId: number): void {
    if (!this.store) return;

    const key = this.store.oneTimePreKeys.find(k => k.id === keyId);
    if (key) {
      key.usedAt = Date.now();
      this.saveStore();
      devLog(`[PreKeyRotation] OneTimePreKey ${keyId} marked as used`);

      // 檢查是否需要補充
      this.checkAndReplenishOneTimePreKeys();
    }
  }

  /**
   * 強制輪換 SignedPreKey
   */
  async forceRotateSignedPreKey(): Promise<void> {
    if (!this.identity || !this.store) {
      throw new Error('Service not initialized');
    }

    await this.rotateSignedPreKey();
    devLog('[PreKeyRotation] SignedPreKey force rotated');
  }

  /**
   * 強制補充 OneTimePreKeys
   */
  async forceReplenishOneTimePreKeys(): Promise<void> {
    if (!this.store) {
      throw new Error('Service not initialized');
    }

    await this.replenishOneTimePreKeys(CONFIG.ONETIME_PREKEY_BATCH_SIZE);
    devLog('[PreKeyRotation] OneTimePreKeys force replenished');
  }

  /**
   * 註冊輪換事件回調
   */
  onRotation(callback: RotationCallback): () => void {
    this.rotationCallbacks.add(callback);
    return () => {
      this.rotationCallbacks.delete(callback);
    };
  }

  /**
   * 取得 PreKeyBundle 資料（用於發布到 MQTT）
   */
  getPreKeyBundleData(): {
    identityKey: Uint8Array;
    signedPreKey: {
      id: number;
      publicKey: Uint8Array;
      signature: Uint8Array;
      timestamp: number;
    };
    oneTimePreKey?: {
      id: number;
      publicKey: Uint8Array;
    };
  } | null {
    if (!this.identity || !this.store?.currentSignedPreKey) {
      return null;
    }

    const availableOTP = this.store.oneTimePreKeys.find(k => !k.usedAt);

    return {
      identityKey: this.identity.publicKey,
      signedPreKey: {
        id: this.store.currentSignedPreKey.id,
        publicKey: fromBase64(this.store.currentSignedPreKey.publicKey),
        signature: fromBase64(this.store.currentSignedPreKey.signature),
        timestamp: this.store.currentSignedPreKey.createdAt,
      },
      oneTimePreKey: availableOTP ? {
        id: availableOTP.id,
        publicKey: fromBase64(availableOTP.publicKey),
      } : undefined,
    };
  }

  // ============================================
  // 私有方法
  // ============================================

  private loadStore(): PreKeyStore {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('[PreKeyRotation] Failed to load store:', err);
    }

    // 返回空的儲存結構
    return {
      currentSignedPreKey: null,
      previousSignedPreKeys: [],
      oneTimePreKeys: [],
      nextOneTimePreKeyId: 1,
      nextSignedPreKeyId: 1,
    };
  }

  private saveStore(): void {
    if (!this.store) return;

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
    } catch (err) {
      console.error('[PreKeyRotation] Failed to save store:', err);
    }
  }

  private async generateInitialKeys(): Promise<void> {
    if (!this.identity || !this.store) {
      throw new Error('Service not initialized');
    }

    // 生成 SignedPreKey
    const signedPreKey = SignedPreKey.generate(this.identity, this.store.nextSignedPreKeyId);
    this.store.currentSignedPreKey = {
      id: signedPreKey.id,
      publicKey: signedPreKey.publicKeyBase64,
      privateKey: toBase64(signedPreKey.privateKey),
      signature: signedPreKey.signatureBase64,
      createdAt: signedPreKey.timestamp,
    };
    this.store.nextSignedPreKeyId++;

    // 生成初始批次的 OneTimePreKeys
    await this.replenishOneTimePreKeys(CONFIG.ONETIME_PREKEY_BATCH_SIZE);

    this.saveStore();
    devLog('[PreKeyRotation] Initial keys generated');

    signedPreKey.free();
  }

  private startPeriodicCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      this.checkAndRotate();
    }, CONFIG.CHECK_INTERVAL);
  }

  private async checkAndRotate(): Promise<void> {
    const status = this.getStatus();

    // 檢查 SignedPreKey 是否需要輪換
    if (status.signedPreKey.needsRotation) {
      devLog('[PreKeyRotation] SignedPreKey needs rotation');
      await this.rotateSignedPreKey();
    }

    // 檢查 OneTimePreKey 是否需要補充
    if (status.oneTimePreKeys.needsReplenishment) {
      devLog('[PreKeyRotation] OneTimePreKeys need replenishment');
      await this.checkAndReplenishOneTimePreKeys();
    }

    // 清理過期的舊 SignedPreKey
    this.cleanupOldSignedPreKeys();
  }

  private async rotateSignedPreKey(): Promise<void> {
    if (!this.identity || !this.store) {
      return;
    }

    const oldKeyId = this.store.currentSignedPreKey?.id;

    // 將當前金鑰移到歷史記錄
    if (this.store.currentSignedPreKey) {
      this.store.currentSignedPreKey.rotatedAt = Date.now();
      this.store.previousSignedPreKeys.push(this.store.currentSignedPreKey);
    }

    // 生成新的 SignedPreKey
    const newSignedPreKey = SignedPreKey.generate(this.identity, this.store.nextSignedPreKeyId);
    this.store.currentSignedPreKey = {
      id: newSignedPreKey.id,
      publicKey: newSignedPreKey.publicKeyBase64,
      privateKey: toBase64(newSignedPreKey.privateKey),
      signature: newSignedPreKey.signatureBase64,
      createdAt: newSignedPreKey.timestamp,
    };
    this.store.nextSignedPreKeyId++;

    this.saveStore();

    // 通知回調
    this.rotationCallbacks.forEach(callback => {
      callback({
        type: 'signed',
        oldKeyId,
        newKeyId: newSignedPreKey.id,
        timestamp: Date.now(),
      });
    });

    devLog(`[PreKeyRotation] SignedPreKey rotated: ${oldKeyId} -> ${newSignedPreKey.id}`);
    newSignedPreKey.free();
  }

  private async checkAndReplenishOneTimePreKeys(): Promise<void> {
    if (!this.store) return;

    const availableCount = this.store.oneTimePreKeys.filter(k => !k.usedAt).length;

    if (availableCount < CONFIG.ONETIME_PREKEY_MIN_COUNT) {
      const needed = Math.min(
        CONFIG.ONETIME_PREKEY_BATCH_SIZE,
        CONFIG.ONETIME_PREKEY_MAX_COUNT - this.store.oneTimePreKeys.length
      );
      if (needed > 0) {
        await this.replenishOneTimePreKeys(needed);
      }
    }
  }

  private async replenishOneTimePreKeys(count: number): Promise<void> {
    if (!this.store) return;

    const newKeys: StoredOneTimePreKey[] = [];

    for (let i = 0; i < count; i++) {
      const otp = OneTimePreKey.generate(this.store.nextOneTimePreKeyId);
      newKeys.push({
        id: otp.id,
        publicKey: otp.publicKeyBase64,
        privateKey: toBase64(otp.privateKey),
        createdAt: Date.now(),
      });
      this.store.nextOneTimePreKeyId++;
      otp.free();
    }

    this.store.oneTimePreKeys.push(...newKeys);
    this.saveStore();

    // 通知回調
    newKeys.forEach(key => {
      this.rotationCallbacks.forEach(callback => {
        callback({
          type: 'onetime',
          newKeyId: key.id,
          timestamp: Date.now(),
        });
      });
    });

    devLog(`[PreKeyRotation] ${count} OneTimePreKeys added`);
  }

  private cleanupOldSignedPreKeys(): void {
    if (!this.store) return;

    const now = Date.now();
    const retentionMs = CONFIG.SIGNED_PREKEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const beforeCount = this.store.previousSignedPreKeys.length;
    this.store.previousSignedPreKeys = this.store.previousSignedPreKeys.filter(key => {
      const rotatedAt = key.rotatedAt || key.createdAt;
      return now - rotatedAt < retentionMs;
    });

    const removedCount = beforeCount - this.store.previousSignedPreKeys.length;
    if (removedCount > 0) {
      this.saveStore();
      devLog(`[PreKeyRotation] Cleaned up ${removedCount} old SignedPreKeys`);
    }

    // 同樣清理已使用的 OneTimePreKeys（保留 7 天）
    const otpRetentionMs = 7 * 24 * 60 * 60 * 1000;
    const beforeOtpCount = this.store.oneTimePreKeys.length;
    this.store.oneTimePreKeys = this.store.oneTimePreKeys.filter(key => {
      if (!key.usedAt) return true;
      return now - key.usedAt < otpRetentionMs;
    });

    const removedOtpCount = beforeOtpCount - this.store.oneTimePreKeys.length;
    if (removedOtpCount > 0) {
      this.saveStore();
      devLog(`[PreKeyRotation] Cleaned up ${removedOtpCount} old OneTimePreKeys`);
    }
  }

  /**
   * 根據 ID 查找 SignedPreKey（包括歷史記錄）
   * 用於處理進行中的會話
   */
  findSignedPreKeyById(keyId: number): SignedPreKey | null {
    if (!this.store) return null;

    // 先檢查當前金鑰
    if (this.store.currentSignedPreKey?.id === keyId) {
      const stored = this.store.currentSignedPreKey;
      return SignedPreKey.fromPrivateKey(
        fromBase64(stored.privateKey),
        stored.id,
        fromBase64(stored.signature),
        stored.createdAt
      );
    }

    // 再檢查歷史金鑰
    const historical = this.store.previousSignedPreKeys.find(k => k.id === keyId);
    if (historical) {
      return SignedPreKey.fromPrivateKey(
        fromBase64(historical.privateKey),
        historical.id,
        fromBase64(historical.signature),
        historical.createdAt
      );
    }

    return null;
  }

  /**
   * 根據 ID 查找 OneTimePreKey
   */
  findOneTimePreKeyById(keyId: number): OneTimePreKey | null {
    if (!this.store) return null;

    const key = this.store.oneTimePreKeys.find(k => k.id === keyId);
    if (!key) return null;

    return OneTimePreKey.fromPrivateKey(
      fromBase64(key.privateKey),
      key.id
    );
  }

  /**
   * 導出配置（用於 UI 顯示）
   */
  getConfig(): typeof CONFIG {
    return { ...CONFIG };
  }
}

// 單例導出
export const preKeyRotationService = new PreKeyRotationService();

export default preKeyRotationService;
