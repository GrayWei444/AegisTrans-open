/**
 * Key Encryption Service - PIN 衍生金鑰加密
 *
 * 使用 Argon2id 從 PIN 衍生 AES-256-GCM 加密金鑰（抗 GPU/ASIC 暴力破解），
 * 用於在 localStorage/SQLite 中加密存放私鑰和 session 資料。
 *
 * 流程：
 * 1. 用戶輸入 PIN → deriveKey(pin, salt) → AES-256-GCM CryptoKey
 * 2. 存入時：encrypt(plaintext, key) → { iv, salt, ciphertext } (base64 JSON)
 * 3. 讀取時：decrypt(encrypted, key) → plaintext
 *
 * 生物辨識登入：
 * - PIN 登入時，CryptoKey 快取到 IndexedDB（non-extractable，raw bytes 永不暴露）
 * - sessionStorage 僅存 marker flag，瀏覽器關閉後 marker 消失
 * - 生物辨識登入時，檢查 marker + 從 IndexedDB 恢復 CryptoKey
 */

import { argon2id } from 'hash-wasm';
import * as db from './database';
import { toBuffer } from '../utils/toBuffer';
import { devLog, devWarn } from '../utils/devLog';

// Argon2id 參數（memory-hard，抗 GPU/ASIC）
const ARGON2_MEMORY = 65536;     // 64 MiB
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 4;
const ARGON2_HASH_LENGTH = 32;   // 256-bit
const SALT_KEY = 'aegis_key_salt';
const SESSION_MARKER_KEY = 'aegis_ek_active';
const SESSION_IDB_NAME = 'aegis_ek_session';
const SESSION_IDB_STORE = 'keys';

let _encryptionKey: CryptoKey | null = null;

/** Chunked Uint8Array → base64 (safe for arbitrarily large buffers) */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32 KB chunks — well under call-stack limits
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return btoa(parts.join(''));
}

/** base64 → Uint8Array */
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// ============================================
// IndexedDB CryptoKey session cache helpers
// Stores non-extractable CryptoKey directly (raw bytes never exposed)
// ============================================

async function _openSessionIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SESSION_IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(SESSION_IDB_STORE);
    };
  });
}

async function _cacheKeyToIDB(key: CryptoKey): Promise<void> {
  const idb = await _openSessionIDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
      tx.objectStore(SESSION_IDB_STORE).put(key, 'encryptionKey');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    idb.close();
  }
}

async function _restoreKeyFromIDB(): Promise<CryptoKey | null> {
  const idb = await _openSessionIDB();
  try {
    return await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = idb.transaction(SESSION_IDB_STORE, 'readonly');
      const request = tx.objectStore(SESSION_IDB_STORE).get('encryptionKey');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  } finally {
    idb.close();
  }
}

async function _clearKeyFromIDB(): Promise<void> {
  // ⚠️ fail-closed（review 2026-07-16 修正）：indexedDB.open(name, 1) 對「從沒存過金鑰」的環境
  // 是「開成功並建立空 store」（onupgradeneeded），並不會 reject —— 所以 open 失敗代表**真正的
  // 問題**（DB 損毀 / 被鎖 / 權限 / 暫時錯誤），此時無法確認舊金鑰是否還在。必須讓錯誤往上拋、由
  // wipeLocalAccountData fail-closed 擋住換帳號，不能當「已清」（否則舊帳號金鑰可能殘留 → 換帳號
  // 隔離破功）。原本「catch → return 視為已清」是基於錯誤前提（把 open 失敗當成從沒存過）。
  const idb = await _openSessionIDB();
  // 開得了就必須真的刪成功：刪除失敗會讓舊帳號金鑰殘留 → 換帳號隔離破功。
  // 失敗往上拋，由 wipeLocalAccountData fail-closed 擋住切換（見 CR-02）。
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction(SESSION_IDB_STORE, 'readwrite');
      tx.objectStore(SESSION_IDB_STORE).delete('encryptionKey');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    idb.close();
  }
}


/**
 * 從 PIN 衍生 AES-256-GCM 加密金鑰
 *
 * @param pin - 用戶 PIN
 * @param options - salt: 預設 salt; isInitialSetup: 跳過 salt guard（首次註冊時使用）
 */
export async function deriveEncryptionKey(
  pin: string,
  options?: Uint8Array | { salt?: Uint8Array; isInitialSetup?: boolean },
): Promise<CryptoKey> {
  // Backward compat: second arg can be raw Uint8Array salt
  let salt: Uint8Array | undefined;
  let isInitialSetup = false;
  if (options instanceof Uint8Array) {
    salt = options;
  } else if (options) {
    salt = options.salt;
    isInitialSetup = !!options.isInitialSetup;
  }

  if (!salt) {
    // Try localStorage first (fast), fallback to SQLite (durable)
    let stored = localStorage.getItem(SALT_KEY);
    if (!stored) {
      try { stored = await db.getSetting(SALT_KEY) ?? null; } catch (e) { devWarn('[keyEncryption] SQLite salt fallback failed:', e); }
    }
    if (stored) {
      salt = base64ToBytes(stored);
      // Ensure dual-write: sync localStorage ↔ SQLite
      if (!localStorage.getItem(SALT_KEY)) {
        localStorage.setItem(SALT_KEY, stored);
      }
      db.setSetting(SALT_KEY, stored).catch(() => {});
    } else {
      // Guard: if PIN-encrypted data already exists but salt is missing,
      // generating a new salt guarantees lockout — refuse to proceed.
      // Skip guard for initial setup (first-time registration) or when
      // ephemeral key exists (data is ephemeral-encrypted, not PIN-encrypted).
      if (!isInitialSetup) {
        const hasEphemeralKey = !!sessionStorage.getItem(EPHEMERAL_KEY_NAME);
        if (!hasEphemeralKey) {
          // AegisTrans 真正的 key/session 存在 aegistrans_*;mist_* 保留給 AegisTalk
          // fork 殘留 / 舊裝置 legacy 相容。任一含加密資料而 salt 已遺失 → 重新產 salt
          // 會 derive 出錯誤的 key 造成永久 lockout,拒絕繼續。
          const guardKeys = ['aegistrans_keys', 'aegistrans_sessions', 'mist_keys', 'mist_sessions'];
          let hasEncryptedData = false;
          for (const gk of guardKeys) {
            if (isEncryptedData(localStorage.getItem(gk) ?? '')) { hasEncryptedData = true; break; }
            try {
              const dbVal = await db.getSetting(gk);
              if (dbVal && isEncryptedData(dbVal)) { hasEncryptedData = true; break; }
            } catch { /* SQLite unavailable */ }
          }
          if (hasEncryptedData) {
            throw new Error('Salt missing but encrypted data exists — cannot derive correct key. Data would be unrecoverable.');
          }
        }
      }
      salt = crypto.getRandomValues(new Uint8Array(32));
      const saltB64 = bytesToBase64(salt);
      localStorage.setItem(SALT_KEY, saltB64);
      db.setSetting(SALT_KEY, saltB64).catch(() => {});
    }
  }

  // Argon2id memory-hard derivation
  const hashHex = await argon2id({
    password: pin,
    salt: salt as Uint8Array,
    memorySize: ARGON2_MEMORY,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM,
    hashLength: ARGON2_HASH_LENGTH,
    outputType: 'hex',
  });
  const rawKey = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < rawKey.length; i++) {
    rawKey[i] = parseInt(hashHex.substring(i * 2, i * 2 + 2), 16);
  }

  // Import as non-extractable AES-GCM CryptoKey
  // Biometric login caches CryptoKey object in IndexedDB (structured clone)
  return crypto.subtle.importKey(
    'raw',
    toBuffer(rawKey),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 設定目前的加密金鑰（PIN/password 驗證成功後呼叫）
 * 同時快取 CryptoKey 到 IndexedDB 供同一 session 的生物辨識登入使用
 * 並自動遷移任何明文 / ephemeral-encrypted aegistrans_keys / aegistrans_sessions
 * （及 legacy mist_*）為正式加密格式
 */
export async function setEncryptionKey(key: CryptoKey): Promise<void> {
  _encryptionKey = key;
  // Cache CryptoKey to IDB (non-extractable, raw bytes never exposed)
  // sessionStorage marker ensures IDB key is only used within same browser session
  try {
    await _cacheKeyToIDB(key);
    sessionStorage.setItem(SESSION_MARKER_KEY, '1');
  } catch {
    // IDB or sessionStorage unavailable
  }
  // Auto-migrate any plaintext/ephemeral-encrypted keys to PIN-encrypted format
  // MUST await so that callers can safely read the re-encrypted data afterward
  try {
    await _migrateStoredKeysIfNeeded(key);
  } catch (err) {
    devWarn('[keyEncryption] Migration failed — plaintext keys may remain unencrypted:', err);
  }
}

/**
 * 遷移明文 / ephemeral-encrypted aegistrans_keys / aegistrans_sessions（及 legacy
 * mist_*）為正式 PIN/password 加密格式。在 setEncryptionKey 後自動呼叫。
 *
 * ⚠️ AegisTrans 真正的 key/session 存在 aegistrans_*（useCrypto.ts 的 STORAGE_KEY /
 * SESSIONS_STORAGE_KEY）。fork 自 AegisTalk 時這裡漏改 → 原本只遷移 mist_*,導致
 * magic-link 先生 key（ephemeral 加密）→ 設密碼後不會被 re-encrypt → 重啟掉
 * sessionStorage ephemeral key 後 ratchet state 永久解不開。mist_* 保留作 legacy。
 */
async function _migrateStoredKeysIfNeeded(key: CryptoKey): Promise<void> {
  const keysToMigrate = ['aegistrans_keys', 'aegistrans_sessions', 'mist_keys', 'mist_sessions'];
  for (const storageKey of keysToMigrate) {
    try {
      // Check both localStorage and SQLite (test cleanup may clear one but not both)
      const lsData = localStorage.getItem(storageKey);
      let sqlData: string | null = null;
      try { sqlData = await db.getSetting(storageKey) ?? null; } catch { /* ignore */ }
      const data = lsData || sqlData;
      if (!data) continue;

      if (isEncryptedData(data)) {
        // Already encrypted — try decrypt with real key first
        try {
          await decryptData(data, key);
          // Correctly encrypted with current key — ensure dual-write
          if (!lsData && sqlData) localStorage.setItem(storageKey, sqlData);
          if (lsData && !sqlData) db.setSetting(storageKey, lsData).catch(() => {});
          continue;
        } catch {
          // Can't decrypt with real key — try ephemeral key from sessionStorage
          const plaintext = await tryDecryptWithEphemeralKey(data);
          if (plaintext) {
            const encrypted = await encryptData(plaintext, key);
            localStorage.setItem(storageKey, encrypted);
            db.setSetting(storageKey, encrypted).catch(() => {});
            try { sessionStorage.removeItem(EPHEMERAL_KEY_NAME); } catch { /* ignore */ }
            devLog(`[keyEncryption] Migrated ephemeral-encrypted ${storageKey} to PIN-encrypted`);
          } else {
            // Neither key works — stale data from previous session, remove it
            devWarn(`[keyEncryption] Removing stale unmigratable ${storageKey} (from previous session)`);
            localStorage.removeItem(storageKey);
            db.setSetting(storageKey, '').catch(() => {});
          }
        }
        continue;
      }

      // Plaintext JSON found — encrypt it
      const encrypted = await encryptData(data, key);
      localStorage.setItem(storageKey, encrypted);
      db.setSetting(storageKey, encrypted).catch(() => {});
      devLog(`[keyEncryption] Migrated plaintext ${storageKey} to encrypted`);
    } catch (err) {
      console.error(`[keyEncryption] Failed to migrate ${storageKey}:`, err);
    }
  }

}

/**
 * CR-04：原子式換金鑰（改密碼用）。
 *
 * 舊行為：改密碼直接 deriveEncryptionKey(新密碼) + setEncryptionKey → migration 用「新 key」
 * 試解既有資料，解不開就當 stale **刪掉** → 身分私鑰 / ratchet session 被改密碼一鍵清空。
 *
 * 正解：用「舊密碼 key」解出明文 → 用「新密碼 key」重新加密 → 寫回。任一筆解不開（舊/新/ephemeral
 * 都試過）就 **throw 中止**，絕不刪資料（呼叫端會回報錯誤，不切換到新 key，保住既有資料）。
 *
 * 呼叫順序：本函式必須在 setEncryptionKey(newKey) **之前** 跑完；跑完後所有 record 已是 newKey
 * 加密，setEncryptionKey 的 migration 用 newKey 解得開 → 不會誤刪。
 */
export async function rekeyProtectedRecords(oldKey: CryptoKey, newKey: CryptoKey): Promise<void> {
  const keys = ['aegistrans_keys', 'aegistrans_sessions', 'mist_keys', 'mist_sessions'];
  for (const k of keys) {
    const lsData = localStorage.getItem(k);
    let sqlData: string | null = null;
    try { sqlData = await db.getSetting(k) ?? null; } catch { /* SQLite 不可用 */ }
    const data = lsData || sqlData;
    if (!data) continue;

    let plaintext: string | null = null;
    if (!isEncryptedData(data)) {
      plaintext = data;  // 明文（pre-encryption / legacy）
    } else {
      // 依序試：舊密碼 key → 新密碼 key（idempotent 重跑）→ ephemeral。都不行就中止，不刪。
      try { plaintext = await decryptData(data, oldKey); } catch { /* try next */ }
      if (plaintext === null) {
        try { await decryptData(data, newKey); continue; } catch { /* already new? no → try eph */ }
      }
      if (plaintext === null) {
        plaintext = await tryDecryptWithEphemeralKey(data);
      }
      if (plaintext === null) {
        throw new Error(`rekey: 無法用舊/新/ephemeral key 解開 ${k} — 中止換金鑰以免遺失資料`);
      }
    }

    const enc = await encryptData(plaintext, newKey);
    localStorage.setItem(k, enc);
    try { await db.setSetting(k, enc); } catch { /* best-effort dual-write */ }
  }
}

/**
 * 從 IndexedDB 恢復加密金鑰（生物辨識登入時呼叫）
 *
 * 安全要求：
 * - 必須有 sessionStorage marker（當前 browser session 曾 PIN 登入）
 * - 或者呼叫方已通過 NativeBiometric 驗證（透過 afterBiometric 參數確認）
 *
 * H15: 不再信任 localStorage 'aegis_biometric_enabled' flag
 * （攻擊者可在 DevTools 設定此 flag 繞過 PIN）
 *
 * CryptoKey 為 non-extractable，即使取得 IDB 存取權也無法匯出原始金鑰。
 */
export async function restoreEncryptionKeyFromSession(afterBiometric = false): Promise<boolean> {
  try {
    const hasSessionMarker = !!sessionStorage.getItem(SESSION_MARKER_KEY);

    if (!hasSessionMarker && !afterBiometric) {
      // No session marker AND not called after biometric auth — stale IDB key, clean up
      _clearKeyFromIDB().catch(() => {});
      return false;
    }

    const key = await _restoreKeyFromIDB();
    if (!key) return false;
    _encryptionKey = key;

    // Ensure session marker is set for subsequent operations in this session
    if (!hasSessionMarker) {
      try { sessionStorage.setItem(SESSION_MARKER_KEY, '1'); } catch { /* ignore */ }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 檢查 IndexedDB 是否有快取的 CryptoKey（不觸發恢復，不改變狀態）
 * 用於 face-first 登入判定：有快取 = 生物特徵登入可行
 */
export async function canRestoreEncryptionKey(): Promise<boolean> {
  try {
    const key = await _restoreKeyFromIDB();
    return key !== null;
  } catch {
    return false;
  }
}

/**
 * 取得目前的加密金鑰
 */
export function getEncryptionKey(): CryptoKey | null {
  return _encryptionKey;
}

/**
 * 加密資料為 JSON 字串（含 iv + ciphertext）
 */
export async function encryptData(plaintext: string, key?: CryptoKey): Promise<string> {
  const k = key ?? _encryptionKey;
  if (!k) throw new Error('Encryption key not available');

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    k,
    encoder.encode(plaintext),
  );

  const payload = {
    v: 1,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(payload);
}

/**
 * 解密資料
 */
export async function decryptData(encrypted: string, key?: CryptoKey): Promise<string> {
  const k = key ?? _encryptionKey;
  if (!k) throw new Error('Encryption key not available');

  const payload = JSON.parse(encrypted);
  if (payload.v !== 1) throw new Error('Unknown encryption version');

  const iv = base64ToBytes(payload.iv);
  const ct = base64ToBytes(payload.ct);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(iv) },
    k,
    toBuffer(ct),
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * 檢查資料是否為加密格式
 */
export function isEncryptedData(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null && parsed.v === 1 && typeof parsed.iv === 'string' && typeof parsed.ct === 'string';
  } catch {
    return false;
  }
}

/**
 * 清除加密金鑰（登出時呼叫）
 */
export async function clearEncryptionKey(): Promise<void> {
  _encryptionKey = null;
  try { sessionStorage.removeItem(SESSION_MARKER_KEY); } catch { /* ignore */ }
  // 必須 await IDB 刪除完成：換帳號時 wipe 之後會立刻 setEncryptionKey 寫新金鑰，
  // 若這裡 fire-and-forget，晚到的刪除會把剛寫的新金鑰刪掉 → reload 後解不開（CR-02 race）。
  await _clearKeyFromIDB();
}

// ============================================
// Ephemeral key helpers (for protecting keys during recovery/transfer)
// ============================================

const EPHEMERAL_KEY_NAME = 'aegis_eph_key';

/**
 * 使用隨機臨時金鑰加密資料（recovery/transfer 時使用）
 * 臨時金鑰存在 sessionStorage，PIN 設定後自動遷移為正式加密
 */
export async function encryptWithEphemeralKey(plaintext: string): Promise<string> {
  // ⚠️ 必須整個 session 共用「同一把」臨時鑰。舊版每次 call 都 generateKey + 覆寫
  // 單一 sessionStorage 槽,導致先寫的 blob(如 aegistrans_keys)被後寫的
  // (aegistrans_sessions)蓋掉臨時鑰 → 先寫那個解不開 → 設密碼遷移時被當 stale 刪掉。
  // 改成:槽裡已有就重用,沒有才生新的。
  const ephKey = await getOrCreateEphemeralKey();
  return encryptData(plaintext, ephKey);
}

/** 取得本 session 的臨時鑰;沒有就生一把存進 sessionStorage(單槽、整 session 共用)。 */
async function getOrCreateEphemeralKey(): Promise<CryptoKey> {
  const existing = sessionStorage.getItem(EPHEMERAL_KEY_NAME);
  if (existing) {
    try {
      return await crypto.subtle.importKey(
        'raw', toBuffer(base64ToBytes(existing)), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']
      );
    } catch { /* corrupt slot → regenerate below */ }
  }
  const ephKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const rawKey = await crypto.subtle.exportKey('raw', ephKey);
  try { sessionStorage.setItem(EPHEMERAL_KEY_NAME, bytesToBase64(new Uint8Array(rawKey))); } catch { /* ignore */ }
  return ephKey;
}

/**
 * 嘗試用 sessionStorage 中的臨時金鑰解密
 */
export async function tryDecryptWithEphemeralKey(encrypted: string): Promise<string | null> {
  const keyB64 = sessionStorage.getItem(EPHEMERAL_KEY_NAME);
  if (!keyB64) return null;
  try {
    const rawKey = base64ToBytes(keyB64);
    const ephKey = await crypto.subtle.importKey(
      'raw', toBuffer(rawKey), { name: 'AES-GCM' }, false, ['decrypt']
    );
    return await decryptData(encrypted, ephKey);
  } catch {
    return null;
  }
}
