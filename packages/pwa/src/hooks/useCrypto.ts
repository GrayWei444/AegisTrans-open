/**
 * useCrypto Hook - 加密功能 React Hook
 *
 * 提供 WASM 加密模組的 React 整合
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  initCrypto,
  Identity,
  SignedPreKey,
  OneTimePreKey,
  Session,
  createPreKeyBundle,
  x3dhInitiator,
  x3dhResponder,
  getCryptoVersion,
  toBase64,
  fromBase64,
  type PreKeyBundleData,
  type RatchetMessage,
} from '../services/crypto';
import * as db from '../services/database';
import {
  getEncryptionKey,
  encryptData,
  decryptData,
  isEncryptedData,
  encryptWithEphemeralKey,
} from '../services/keyEncryption';
import { preKeyRotationService } from '../services/preKeyRotation';
import { setLocalIdentity } from '../services/identity';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';

// 金鑰儲存類型
interface StoredKeys {
  identity: {
    publicKey: string; // Base64
    privateKey: string; // Base64
  };
  signedPreKey: {
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    timestamp: number;
  };
  oneTimePreKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
  }>;
}

// Hook 狀態
interface CryptoState {
  initialized: boolean;
  loading: boolean;
  error: Error | null;
  identity: Identity | null;
  signedPreKey: SignedPreKey | null;
  oneTimePreKeys: OneTimePreKey[];
  keysLocked: boolean; // true when encrypted keys exist but no encryption key is available
  version: string | null;
}

// Session 儲存 key
const SESSIONS_STORAGE_KEY = 'aegistrans_sessions';

// IndexedDB 儲存鍵
const STORAGE_KEY = 'aegistrans_keys';

// Session 版本 - 當 Double Ratchet 邏輯修改時需要遞增此值
// v2: 修正 initAsBob chain key 問題
const SESSION_VERSION = 2;
const SESSION_VERSION_KEY = 'aegistrans_session_version';

// WASM 核心版本儲存鍵 - 當 WASM 核心更新時自動清除舊 session
const WASM_CORE_VERSION_KEY = 'aegistrans_wasm_core_version';

/**
 * 加密功能 Hook
 */
export function useCrypto() {
  const [state, setState] = useState<CryptoState>({
    initialized: false,
    loading: true,
    error: null,
    identity: null,
    signedPreKey: null,
    oneTimePreKeys: [],
    version: null,
    keysLocked: false,
  });

  // 使用 ref 存儲 sessions，避免 React state 更新延遲問題
  // 這樣 session 的存取是同步的，不會有 race condition
  const sessionsRef = useRef<Map<string, Session>>(new Map());
  // 記錄每個 session 是用哪個 senderEphemeral 建立的 (base64)。
  // 用途:區分「MQTT 重投遞同一個 X3DH_INIT」(同 ephemeral → skip) vs
  //       「對方重啟/重登建新 session」(不同 ephemeral → 必須 replace,
  //        否則本地用舊 key、對方用新 key → AEAD decrypt 永遠失敗,
  //        使用者只能登出再登入才能清掉舊 session)。
  const acceptedEphemeralsRef = useRef<Map<string, string>>(new Map());
  // Glare tiebreak: if both devices initiate X3DH at the same time, the larger
  // pubkey keeps Alice and the smaller side rebuilds as Bob.
  const initiatedAtRef = useRef<Map<string, number>>(new Map());

  // Phase 29: 儲存 privateKey base64 供多設備同步使用
  const privateKeyBase64Ref = useRef<string | null>(null);

  // Track latest state in ref for cleanup (avoids stale closure capturing initial state)
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * 初始化加密模組
   */
  const initialize = useCallback(async () => {
    try {
      devLog('[DIAG] useCrypto: initialize starting...');
      setState((s) => ({ ...s, loading: true, error: null }));

      // 初始化 WASM
      await initCrypto();
      devLog('[DIAG] useCrypto: WASM initCrypto() done');

      // Migrate keys from localStorage to SQLite (one-time)
      await db.migrateFromLocalStorage(STORAGE_KEY);
      await db.migrateFromLocalStorage(SESSIONS_STORAGE_KEY);
      await db.migrateFromLocalStorage(SESSION_VERSION_KEY);
      await db.migrateFromLocalStorage(WASM_CORE_VERSION_KEY);

      // 取得當前 WASM 核心版本
      const currentWasmVersion = getCryptoVersion();
      devLog('[useCrypto] WASM core version:', currentWasmVersion);

      // 檢查 WASM 核心版本，如果版本不符則清除舊的 sessions
      const storedWasmVersion = await db.getSetting(WASM_CORE_VERSION_KEY) ?? localStorage.getItem(WASM_CORE_VERSION_KEY);
      if (storedWasmVersion && storedWasmVersion !== currentWasmVersion) {
        devWarn(`[useCrypto] ⚠️ WASM core version changed: ${storedWasmVersion} -> ${currentWasmVersion}`);
        devWarn('[useCrypto] Clearing all sessions due to WASM core update...');
        localStorage.removeItem(SESSIONS_STORAGE_KEY);
        db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});
        // 通知用戶（可選）
        devWarn('[useCrypto] Sessions cleared - need to re-establish connections with contacts');
      }
      localStorage.setItem(WASM_CORE_VERSION_KEY, currentWasmVersion);
      db.setSetting(WASM_CORE_VERSION_KEY, currentWasmVersion).catch(() => {});

      // 檢查 session 協議版本，如果版本不符則清除舊的 sessions
      const storedVersion = await db.getSetting(SESSION_VERSION_KEY) ?? localStorage.getItem(SESSION_VERSION_KEY);
      const currentVersion = SESSION_VERSION.toString();
      if (storedVersion !== currentVersion) {
        devLog(`[useCrypto] Session protocol version mismatch: ${storedVersion} -> ${currentVersion}, clearing old sessions`);
        localStorage.removeItem(SESSIONS_STORAGE_KEY);
        db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});
        localStorage.setItem(SESSION_VERSION_KEY, currentVersion);
        db.setSetting(SESSION_VERSION_KEY, currentVersion).catch(() => {});
      }

      // 嘗試從 SQLite 載入已存在的金鑰（fallback to localStorage）
      const storedKeys = await loadKeysFromDb();

      if (storedKeys) {
        // 還原金鑰
        const identity = Identity.fromPrivateKey(fromBase64(storedKeys.identity.privateKey));
        const signedPreKey = SignedPreKey.fromPrivateKey(
          fromBase64(storedKeys.signedPreKey.privateKey),
          storedKeys.signedPreKey.id,
          fromBase64(storedKeys.signedPreKey.signature),
          storedKeys.signedPreKey.timestamp
        );
        let oneTimePreKeys = storedKeys.oneTimePreKeys.map((k) =>
          OneTimePreKey.fromPrivateKey(fromBase64(k.privateKey), k.id)
        );

        // If no OTPs available (e.g. after device transfer/recovery), generate fresh ones
        if (oneTimePreKeys.length === 0) {
          devLog('[useCrypto] No OTPs found — generating fresh prekeys');
          oneTimePreKeys = Array.from({ length: 10 }, (_, i) =>
            OneTimePreKey.generate(i + 1)
          );
          // Persist updated keys with new OTPs
          await saveKeys({
            identity: storedKeys.identity,
            signedPreKey: storedKeys.signedPreKey,
            oneTimePreKeys: oneTimePreKeys.map((k) => ({
              id: k.id,
              publicKey: k.publicKeyBase64,
              privateKey: toBase64(k.privateKey),
            })),
          });
        }

        // 還原 sessions (async to prefer SQLite source)
        await restoreSessions(sessionsRef);

        privateKeyBase64Ref.current = storedKeys.identity.privateKey;

        // 公鑰快取 + mqtt gate
        setLocalIdentity(identity.publicKeyBase64);

        devLog(`[DIAG] useCrypto: Keys loaded OK, identity=${identity.publicKeyBase64.slice(0,12)}...`);
        setState((s) => ({
          ...s,
          initialized: true,
          loading: false,
          identity,
          signedPreKey,
          oneTimePreKeys,
          version: getCryptoVersion(),
        }));
      } else {
        // No keys loaded — check if data is encrypted (locked, not absent)
        const rawData = await db.getSetting(STORAGE_KEY) ?? localStorage.getItem(STORAGE_KEY);
        const locked = !!rawData && isEncryptedData(rawData);
        devLog(`[DIAG] useCrypto: No keys loaded, locked=${locked}, rawData=${!!rawData}`);
        if (locked) {
          devWarn('[useCrypto] Keys are encrypted but no encryption key available — keys locked');
        }
        setState((s) => ({
          ...s,
          initialized: true,
          loading: false,
          keysLocked: locked,
          version: getCryptoVersion(),
        }));
      }
    } catch (error) {
      devLog('[DIAG] useCrypto: initialize FAILED:', error);
      setState((s) => ({
        ...s,
        loading: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }));
    }
  }, []);

  /**
   * 生成新的**隨機**身份金鑰（AegisTalk 式 Identity.generate()）。
   *
   * 2026-06：不再接受 email+fingerprint 派生的 identity 注入 —— 一律隨機，
   * 私鑰只存在本機（加密儲存）。**必須在 encKey 到位後呼叫**，否則 saveKeys
   * 走 ephemeral，重啟後解不開（呼叫端 App.tsx 已 gate 在 getEncryptionKey()）。
   */
  const generateIdentity = useCallback(() => {
    if (!state.initialized) {
      throw new Error('Crypto not initialized');
    }

    // 隨機生成身分私鑰（AegisTalk 路徑）
    const identity = Identity.generate();
    const signedPreKey = SignedPreKey.generate(identity, 1);
    const oneTimePreKeys = Array.from({ length: 10 }, (_, i) =>
      OneTimePreKey.generate(i + 1)
    );

    // 儲存金鑰 (async — fire-and-forget since generateIdentity is sync)
    saveKeys({
      identity: {
        publicKey: identity.publicKeyBase64,
        privateKey: toBase64(identity.privateKey),
      },
      signedPreKey: {
        id: signedPreKey.id,
        publicKey: signedPreKey.publicKeyBase64,
        privateKey: toBase64(signedPreKey.privateKey),
        signature: toBase64(signedPreKey.signature),
        timestamp: signedPreKey.timestamp,
      },
      oneTimePreKeys: oneTimePreKeys.map((k) => ({
        id: k.id,
        publicKey: k.publicKeyBase64,
        privateKey: toBase64(k.privateKey),
      })),
    }).catch(err => devWarn('[useCrypto] Failed to save keys after generate:', err));

    // 公鑰快取 + mqtt gate（非 React 路徑 mqtt.ts / SettingsPage 同步取用）
    setLocalIdentity(identity.publicKeyBase64);

    setState((s) => ({
      ...s,
      identity,
      signedPreKey,
      oneTimePreKeys,
    }));

    return identity.publicKeyBase64;
  }, [state.initialized]);

  /**
   * 取得 PreKeyBundle
   */
  const getPreKeyBundle = useCallback((): string | null => {
    const { identity, signedPreKey, oneTimePreKeys } = state;
    if (!identity || !signedPreKey) {
      return null;
    }

    const oneTimePreKey = oneTimePreKeys[0]; // 使用第一個可用的 OTP

    const bundleData: PreKeyBundleData = {
      identityKey: identity.publicKey,
      signedPreKey: {
        id: signedPreKey.id,
        publicKey: signedPreKey.publicKey,
        signature: signedPreKey.signature,
        timestamp: signedPreKey.timestamp,
      },
      oneTimePreKey: oneTimePreKey
        ? {
            id: oneTimePreKey.id,
            publicKey: oneTimePreKey.publicKey,
          }
        : undefined,
    };

    return createPreKeyBundle(bundleData);
  }, [state]);

  /**
   * AegisTrans-specific：取結構化的 PreKey bundle（給非 React 服務注入）
   *
   * Phase 1 收尾項目 D：改從 preKeyRotationService 取（單一 source of truth）。
   * 服務管理 SPK 30 天輪換 + OTP <10 自動補滿；advertise 出去的就是當下 active 的 SPK
   * 跟可用的 OTP，跟 X3DH responder lookup 那側用的同一把。
   */
  const getPreKeyBundleData = useCallback((): {
    signedPreKeyId: number;
    signedPreKeyPublic: string;
    signedPreKeySignature: string;
    signedPreKeyTimestamp: number;
    oneTimePreKeyId?: number;
    oneTimePreKeyPublic?: string;
  } | null => {
    const data = preKeyRotationService.getPreKeyBundleData();
    if (!data) return null;
    return {
      signedPreKeyId: data.signedPreKey.id,
      signedPreKeyPublic: toBase64(data.signedPreKey.publicKey),
      signedPreKeySignature: toBase64(data.signedPreKey.signature),
      signedPreKeyTimestamp: data.signedPreKey.timestamp,
      oneTimePreKeyId: data.oneTimePreKey?.id,
      oneTimePreKeyPublic: data.oneTimePreKey ? toBase64(data.oneTimePreKey.publicKey) : undefined,
    };
  }, []);

  /**
   * 建立與對方的會話 (作為發起者)
   */
  const createSession = useCallback(
    (
      recipientIdentityPublic: Uint8Array,
      recipientSignedPrekeyPublic: Uint8Array,
      recipientSignedPrekeySignature: Uint8Array,
      recipientOneTimePrekeyPublic?: Uint8Array,
      recipientOneTimePrekeyId?: number,
      forceFresh?: boolean
    ) => {
      const { identity } = state;
      if (!identity) {
        throw new Error('Identity not initialized');
      }

      // 執行 X3DH（initiator path 只用 identity + recipient bundle，不用 own SPK）
      const x3dhResult = x3dhInitiator(
        identity,
        recipientIdentityPublic,
        recipientSignedPrekeyPublic,
        recipientSignedPrekeySignature,
        recipientOneTimePrekeyPublic,
        recipientOneTimePrekeyId
      );

      // 建立 Double Ratchet 會話 (使用 X3DH 的臨時金鑰對)
      const session = Session.initAsAlice(
        x3dhResult.sharedSecret,
        recipientSignedPrekeyPublic,
        x3dhResult.ephemeralPrivateKey,
        x3dhResult.ephemeralPublicKey
      );

      // 歸零敏感密鑰材料
      x3dhResult.sharedSecret.fill(0);
      x3dhResult.ephemeralPrivateKey.fill(0);

      // 儲存會話到 ref（同步，立即可用）
      const recipientKeyBase64 = toBase64(recipientIdentityPublic);

      // Idempotency: 預設已有 session 就拒絕覆蓋（防止 MQTT 重投遞重置 ratchet）。
      // forceFresh 是 authoritative reset 例外：剛產生的新 ephemeral 必須和新的 Alice
      // session 同源，否則 caller 送新 ephemeral、我方卻沿用舊 ratchet → 對端 aead。
      const existingForRecipient = sessionsRef.current.get(recipientKeyBase64);
      if (existingForRecipient && !forceFresh) {
        diagLog('[DIAG:CRYPTO] createSession SKIPPED — session already exists for', recipientKeyBase64.slice(0, 16));
        // 釋放剛建立但未使用的新 session
        try { session.free(); } catch { /* ignore */ }
        return {
          session: existingForRecipient,
          ephemeralPublicKey: x3dhResult.ephemeralPublicKey,
          usedOneTimePrekeyId: x3dhResult.usedOneTimePrekeyId,
        };
      }
      if (existingForRecipient) {
        try { existingForRecipient.free(); } catch { /* ignore */ }
        console.error('[DIAG:CRYPTO] createSession forceFresh — replaced existing Alice session for', recipientKeyBase64.slice(0, 16));
      }

      sessionsRef.current.set(recipientKeyBase64, session);
      acceptedEphemeralsRef.current.delete(recipientKeyBase64);
      initiatedAtRef.current.set(recipientKeyBase64, Date.now());
      devLog('[useCrypto] Session created (as Alice) for:', recipientKeyBase64.slice(0, 16) + '...');
      devLog('[useCrypto] Total sessions:', sessionsRef.current.size);
      diagLog('[DIAG:CRYPTO] createSession (initAsAlice) for:', recipientKeyBase64.slice(0, 16));

      // 持久化 session
      saveSession(recipientKeyBase64, session);

      return {
        session,
        ephemeralPublicKey: x3dhResult.ephemeralPublicKey,
        usedOneTimePrekeyId: x3dhResult.usedOneTimePrekeyId,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.identity]
  );

  /**
   * 接受對方建立的會話 (作為接收者)
   *
   * Idempotent: 若已有 session，直接回傳現有 session，不重新初始化
   * （防止 MQTT 重投遞 X3DH_INIT 重置 Double Ratchet 狀態 → aead::Error）
   */
  const acceptSession = useCallback(
    (
      senderIdentityPublic: Uint8Array,
      senderEphemeralPublic: Uint8Array,
      usedOneTimePrekeyId?: number,
      forceReset?: boolean
    ) => {
      const { identity } = state;
      if (!identity) {
        throw new Error('Identity not initialized');
      }

      // Idempotency 區分兩種情況:
      //   1. MQTT 重投遞同一個 X3DH_INIT(同 senderEphemeral)→ 跳過,保留現有 ratchet 狀態
      //   2. 對方重啟/重登建新 session(不同 senderEphemeral)→ 必須 replace,
      //      否則本地 ratchet key 跟對方對不上,所有後續訊息 AEAD decrypt 失敗
      const senderKeyBase64Check = toBase64(senderIdentityPublic);
      const senderEphemeralB64 = toBase64(senderEphemeralPublic);
      const existingSession = sessionsRef.current.get(senderKeyBase64Check);
      const lastEphemeralB64 = acceptedEphemeralsRef.current.get(senderKeyBase64Check);
      if (existingSession && lastEphemeralB64 === senderEphemeralB64) {
        diagLog('[DIAG:CRYPTO] acceptSession SKIPPED — redelivery (same ephemeral) for', senderKeyBase64Check.slice(0, 16));
        return existingSession;
      }
      const recentlyInitiated = (Date.now() - (initiatedAtRef.current.get(senderKeyBase64Check) ?? 0)) < 30_000;
      if (forceReset) {
        initiatedAtRef.current.delete(senderKeyBase64Check);
        if (existingSession) {
          console.error('[DIAG:CRYPTO] acceptSession forceReset — dropping existing session, rebuilding as Bob for', senderKeyBase64Check.slice(0, 16));
        }
      } else if (existingSession && recentlyInitiated && identity.publicKeyBase64 > senderKeyBase64Check) {
        diagLog('[DIAG:CRYPTO] acceptSession GLARE — lex-larger + recently initiated → keep my initiator session for', senderKeyBase64Check.slice(0, 16));
        return existingSession;
      }
      if (existingSession) {
        diagLog('[DIAG:CRYPTO] acceptSession REPLACING — peer reset/new ephemeral for', senderKeyBase64Check.slice(0, 16));
      }

      // Phase 1 收尾項目 D：SPK / OTP 都從 preKeyRotationService 取（單一 source of truth）
      const signedPreKey = preKeyRotationService.getCurrentSignedPreKey();
      if (!signedPreKey) {
        throw new Error('SignedPreKey not available from preKeyRotationService');
      }

      let usedOTP: OneTimePreKey | null = null;
      if (usedOneTimePrekeyId !== undefined) {
        usedOTP = preKeyRotationService.findOneTimePreKeyById(usedOneTimePrekeyId);
        if (!usedOTP) {
          devWarn(`[useCrypto] OTP id=${usedOneTimePrekeyId} not found in preKeyRotationService — proceeding without OTP`);
        }
      }

      try {
        let sharedSecret: Uint8Array | null = null;
        let session: Session;
        try {
          // 執行 X3DH
          sharedSecret = x3dhResponder(
            identity,
            signedPreKey,
            usedOTP,
            senderIdentityPublic,
            senderEphemeralPublic
          );

          // 建立 Double Ratchet 會話（傳入 Alice 的臨時公鑰以支援雙向通訊）
          session = Session.initAsBob(
            sharedSecret,
            signedPreKey.privateKey,
            signedPreKey.publicKey,
            senderEphemeralPublic
          );
        } catch (err) {
          console.error('[DIAG:CRYPTO] acceptSession FAILED to build Bob session for', senderKeyBase64Check.slice(0, 16), ':', String(err));
          throw err;
        } finally {
          sharedSecret?.fill(0);
        }

        // 只有新 Bob 成功建好後才丟舊 session，避免壞 reset 封包造成可用 session 遺失。
        if (existingSession) {
          try { existingSession.free(); } catch { /* ignore */ }
          sessionsRef.current.delete(senderKeyBase64Check);
          acceptedEphemeralsRef.current.delete(senderKeyBase64Check);
        }

        // 儲存會話到 ref（同步，立即可用）
        const senderKeyBase64 = toBase64(senderIdentityPublic);
        sessionsRef.current.set(senderKeyBase64, session);
        acceptedEphemeralsRef.current.set(senderKeyBase64, senderEphemeralB64);
        devLog('[useCrypto] Session created (as Bob) for:', senderKeyBase64.slice(0, 16) + '...');
        devLog('[useCrypto] Total sessions:', sessionsRef.current.size);

        // 持久化 session
        saveSession(senderKeyBase64, session);

        // Phase 1 收尾項目 D：mark OTP used → service 自動 OTP <10 補滿
        if (usedOneTimePrekeyId !== undefined && usedOTP) {
          preKeyRotationService.markOneTimePreKeyUsed(usedOneTimePrekeyId);
        }

        return session;
      } finally {
        // 釋放從 service 借出的 WASM handles（避免 leak）
        try { signedPreKey.free(); } catch { /* ignore */ }
        if (usedOTP) {
          try { usedOTP.free(); } catch { /* ignore */ }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.identity]
  );

  // Per-session 互斥鎖，防止並發 encrypt/decrypt 損壞 Ratchet 狀態
  const sessionLocksRef = useRef<Map<string, Promise<void>>>(new Map());

  const withSessionLock = useCallback(
    async <T>(key: string, fn: () => T | Promise<T>): Promise<T> => {
      const prev = sessionLocksRef.current.get(key) ?? Promise.resolve();
      let resolve: () => void;
      const next = new Promise<void>((r) => { resolve = r; });
      sessionLocksRef.current.set(key, next);
      try {
        await prev;
        // ⚠️ 必須 await fn()：若 fn 回傳 Promise（async callback），
        // `return fn()` 會讓 finally 提前釋放鎖 → 並發 encrypt/decrypt race
        return await fn();
      } finally {
        resolve!();
      }
    },
    []
  );

  /**
   * 加密訊息（async — 序列化同一 session 的操作）
   *
   * Phase 35: 單裝置政策已生效（talk_active_device），多裝置 session 同步邏輯已移除
   */
  const encrypt = useCallback(
    async (recipientPublicKeyBase64: string, plaintext: string): Promise<RatchetMessage> => {
      const result = await withSessionLock(recipientPublicKeyBase64, async () => {
        // ⚠️(F5 port AegisTalk) ratchet 狀態唯一真實來源是 DB：每次 encrypt 前都從 DB 重載 session，
        // 不信任 in-memory map。元件 remount churn 會讓多個 mount 各持有分叉的 session 快取——舊 mount
        // 可能停在「尚未首送」None 狀態,用它首送會 ratchet 出第二把 sending DH(≠ DB 已落地那把)→
        // 對端 root key 已前進 → aead。對齊 decrypt 的 aead-retry：reload→set→op→save。
        let session = sessionsRef.current.get(recipientPublicKeyBase64);
        try {
          const stored = await loadAllSessionsFromDb();
          const base64Data = stored[recipientPublicKeyBase64];
          if (base64Data) {
            const fresh = Session.deserialize(fromBase64(base64Data));
            sessionsRef.current.set(recipientPublicKeyBase64, fresh);
            session = fresh;
          }
        } catch (reloadErr) {
          // DB 重載失敗（極早期 cold-start、keys 未解鎖）→ 退回 in-memory（首送前 DB 尚無 blob 的短窗）
          devWarn('[useCrypto] encrypt: DB session reload failed, using in-memory session:', String(reloadErr));
        }
        if (!session) {
          devLog('[useCrypto] No session for encrypt. Looking for:', recipientPublicKeyBase64.slice(0, 16) + '...');
          devLog('[useCrypto] Available sessions:', Array.from(sessionsRef.current.keys()).map(k => k.slice(0, 16) + '...'));
          throw new Error('No session with this recipient');
        }
        const encrypted = session.encrypt(plaintext);
        // [DIAG] 記錄送出訊息的 ratchet metadata（msg_num/prev/dh_public）— 對齊發/收兩端的計數器
        try {
          console.error(
            '[DIAG:RATCHET:SEND]',
            'to:', recipientPublicKeyBase64.slice(0, 16),
            'msgNum:', encrypted.messageNumber,
            'prev:', encrypted.prevChainCount,
            'dh:', encrypted.dhPublicBase64.slice(0, 16)
          );
        } catch {}
        // 加密後 **同步等待** 持久化完成（ratchet 狀態已推進，必須先落 DB 才能回傳訊息給呼叫端）
        // 否則 page reload 在 save 完成前發生 → DB 回退 → 下次 encrypt 重用已用過的 Ns → 對端 aead::Error
        await saveSession(recipientPublicKeyBase64, session);
        return encrypted;
      });

      return result;
    },
    [withSessionLock]
  );

  /**
   * 解密訊息（async — 序列化同一 session 的操作）
   * aead::Error 時自動從 DB 重載 session 重試一次（修復群聊→個聊切換導致的 ratchet 不同步）
   */
  const decrypt = useCallback(
    async (senderPublicKeyBase64: string, message: RatchetMessage): Promise<string> => {
      // [DIAG] 記錄收到訊息的 ratchet metadata — 與 [DIAG:RATCHET:SEND] 對齊比對偏移
      try {
        console.error(
          '[DIAG:RATCHET:RECV]',
          'from:', senderPublicKeyBase64.slice(0, 16),
          'msgNum:', message.messageNumber,
          'prev:', message.prevChainCount,
          'dh:', message.dhPublicBase64.slice(0, 16)
        );
      } catch {}

      const tryDecrypt = async (session: Session): Promise<string> => {
        const decrypted = session.decryptToString(message);
        // 解密後 **同步等待** 持久化完成（ratchet 狀態已推進）
        // 否則 page reload 在 save 完成前發生 → DB 回退 → 下次收到同一訊息會再次推進 Nr → aead::Error
        await saveSession(senderPublicKeyBase64, session);
        return decrypted;
      };

      // 第一次嘗試：使用記憶體中的 session
      try {
        return await withSessionLock(senderPublicKeyBase64, async () => {
          const session = sessionsRef.current.get(senderPublicKeyBase64);
          if (!session) {
            console.error('[useCrypto] No session for decrypt:', senderPublicKeyBase64.slice(0, 16) + '...');
            throw new Error('No session with this sender');
          }
          return tryDecrypt(session);
        });
      } catch (firstErr) {
        const errMsg = String(firstErr);
        // 只有 aead 相關錯誤才重試（其他錯誤直接拋出）
        if (!errMsg.includes('aead') && !errMsg.includes('AEAD') && !errMsg.includes('decrypt')) {
          throw firstErr;
        }

        diagLog('[DIAG:CRYPTO] Decrypt FAILED (aead), reloading session from DB for retry:', senderPublicKeyBase64.slice(0, 16) + '...', 'err:', errMsg);

        // 第二次嘗試：從 DB 重載 session（可能其他 tab/設備更新了 ratchet 狀態）
        try {
          const stored = await loadAllSessionsFromDb();
          const base64Data = stored[senderPublicKeyBase64];
          if (!base64Data) {
            diagLog('[DIAG:CRYPTO] No session in DB for retry — giving up');
            throw firstErr;
          }

          const freshSession = Session.deserialize(fromBase64(base64Data));

          return await withSessionLock(senderPublicKeyBase64, async () => {
            // 用從 DB 載入的 fresh session 替換記憶體中的
            sessionsRef.current.set(senderPublicKeyBase64, freshSession);
            try {
              const result = await tryDecrypt(freshSession);
              diagLog('[DIAG:CRYPTO] Decrypt SUCCEEDED on retry with DB session for', senderPublicKeyBase64.slice(0, 16));
              return result;
            } catch (retryErr) {
              diagLog('[DIAG:CRYPTO] Decrypt FAILED on retry too for', senderPublicKeyBase64.slice(0, 16), ':', String(retryErr));
              throw retryErr;
            }
          });
        } catch (reloadErr) {
          if (reloadErr === firstErr) throw firstErr;
          console.error('[useCrypto] Session reload/retry failed:', reloadErr);
          throw firstErr; // 拋出原始錯誤
        }
      }
    },
    [withSessionLock]
  );

  /**
   * 解鎖並重新載入加密的金鑰（PIN 驗證或生物辨識成功後呼叫）
   * 需要先呼叫 setEncryptionKey() 設定加密金鑰
   */
  const unlockAndReloadKeys = useCallback(async (): Promise<boolean> => {
    try {
      const storedKeys = await loadKeysFromDb();
      if (!storedKeys) {
        // No decryptable keys found — reset keysLocked so AppProvider can
        // re-generate identity (stale data may have been cleaned by migration)
        devWarn('[useCrypto] unlockAndReloadKeys — no keys found, resetting keysLocked');
        setState((s) => ({ ...s, keysLocked: false }));
        return false;
      }

      const identity = Identity.fromPrivateKey(fromBase64(storedKeys.identity.privateKey));
      const signedPreKey = SignedPreKey.fromPrivateKey(
        fromBase64(storedKeys.signedPreKey.privateKey),
        storedKeys.signedPreKey.id,
        fromBase64(storedKeys.signedPreKey.signature),
        storedKeys.signedPreKey.timestamp
      );
      const oneTimePreKeys = storedKeys.oneTimePreKeys.map((k) =>
        OneTimePreKey.fromPrivateKey(fromBase64(k.privateKey), k.id)
      );

      await restoreSessions(sessionsRef);

      privateKeyBase64Ref.current = storedKeys.identity.privateKey;

      // 公鑰快取 + mqtt gate
      setLocalIdentity(identity.publicKeyBase64);

      setState((s) => ({
        ...s,
        identity,
        signedPreKey,
        oneTimePreKeys,
        keysLocked: false,
      }));

      devLog('[useCrypto] Keys unlocked and restored successfully');
      return true;
    } catch (err) {
      console.error('[useCrypto] unlockAndReloadKeys failed:', err);
      return false;
    }
  }, []);

  /**
   * 清除所有金鑰
   */
  const clearKeys = useCallback(() => {
    // 釋放記憶體
    state.identity?.free();
    state.signedPreKey?.free();
    state.oneTimePreKeys.forEach((k) => k.free());
    sessionsRef.current.forEach((s) => s.free());

    // 清除儲存
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SESSIONS_STORAGE_KEY);
    localStorage.removeItem(SESSION_VERSION_KEY);
    localStorage.removeItem(WASM_CORE_VERSION_KEY);
    // Also clear from SQLite
    db.deleteSetting(STORAGE_KEY).catch(() => {});
    db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});
    db.deleteSetting(SESSION_VERSION_KEY).catch(() => {});
    db.deleteSetting(WASM_CORE_VERSION_KEY).catch(() => {});

    // 清空 sessions ref
    sessionsRef.current = new Map();
    acceptedEphemeralsRef.current = new Map();
    initiatedAtRef.current = new Map();

    // Phase 29: 清除 privateKey ref
    privateKeyBase64Ref.current = null;

    devLog('[useCrypto] All keys and sessions cleared');

    setState((s) => ({
      ...s,
      identity: null,
      signedPreKey: null,
      oneTimePreKeys: [],
    }));
  }, [state.identity, state.signedPreKey, state.oneTimePreKeys]);

  /**
   * 只清除 sessions（保留身份金鑰）
   * 用於 session 同步問題時重建連線
   */
  const clearSessions = useCallback(() => {
    // 釋放 session 記憶體
    sessionsRef.current.forEach((s) => s.free());
    sessionsRef.current = new Map();
    acceptedEphemeralsRef.current = new Map();
    initiatedAtRef.current = new Map();

    // 清除 session 儲存
    localStorage.removeItem(SESSIONS_STORAGE_KEY);
    db.deleteSetting(SESSIONS_STORAGE_KEY).catch(() => {});

    devLog('[useCrypto] All sessions cleared (identity preserved)');
  }, []);

  // 自動初始化
  useEffect(() => {
    initialize();

    // 清理函式 — use stateRef to capture latest state, not stale initial closure
    return () => {
      stateRef.current.identity?.free();
      stateRef.current.signedPreKey?.free();
      stateRef.current.oneTimePreKeys.forEach((k) => k.free());
      sessionsRef.current.forEach((s) => s.free());
      acceptedEphemeralsRef.current = new Map();
      initiatedAtRef.current = new Map();
      privateKeyBase64Ref.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // 狀態
    initialized: state.initialized,
    isInitialized: state.initialized, // 別名
    loading: state.loading,
    error: state.error,
    version: state.version,
    hasIdentity: !!state.identity,
    keysLocked: state.keysLocked, // 加密金鑰存在但無法解密（等待 PIN 輸入）
    identity: state.identity, // 暴露完整身份物件 (用於驗證簽章)
    signedPreKey: state.signedPreKey, // 暴露 SignedPreKey (用於 QR Code)
    oneTimePreKeys: state.oneTimePreKeys, // 暴露 OneTimePreKeys (用於 E2E 測試)
    publicKeyBase64: state.identity?.publicKeyBase64 ?? null,

    // 金鑰管理
    generateIdentity,
    getPreKeyBundle,
    getPreKeyBundleData,
    clearKeys,
    clearSessions, // 只清除 sessions，保留身份
    unlockAndReloadKeys, // PIN/生物辨識成功後解鎖加密的金鑰

    // 會話管理
    createSession,
    acceptSession,
    /** AegisTrans-specific: 給非 React 服務查詢是否已配對 */
    hasSession: (peerPubkeyBase64: string) => sessionsRef.current.has(peerPubkeyBase64),

    // 加解密
    encrypt,
    decrypt,
  };
}

// ============================================
// 金鑰儲存輔助函式
// ============================================

async function saveKeys(keys: StoredKeys): Promise<void> {
  try {
    const json = JSON.stringify(keys);
    const encKey = getEncryptionKey();
    if (encKey) {
      const encrypted = await encryptData(json, encKey);
      localStorage.setItem(STORAGE_KEY, encrypted);
      db.setSetting(STORAGE_KEY, encrypted).catch(() => {});
    } else {
      // Guard: refuse to downgrade from encrypted to plaintext
      const existing = localStorage.getItem(STORAGE_KEY);
      if (existing && isEncryptedData(existing)) {
        devWarn('[useCrypto] Refusing to save plaintext keys — data is currently encrypted but no encKey available');
        return;
      }
      // No encryption key yet (first-time setup before PIN) — use ephemeral encryption
      // The ephemeral key is stored in sessionStorage; keyEncryption._migrateStoredKeysIfNeeded()
      // will re-encrypt with the real PIN-derived key once the user sets their PIN
      const ephEncrypted = await encryptWithEphemeralKey(json);
      localStorage.setItem(STORAGE_KEY, ephEncrypted);
      db.setSetting(STORAGE_KEY, ephEncrypted).catch(() => {});
    }
  } catch (error) {
    devWarn('Failed to save keys:', error);
  }
}

// Sync version (reads localStorage cache) - used during init before SQLite is ready
// Returns null if data is encrypted (caller must use async version after PIN entry)
function loadKeys(): StoredKeys | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;
    if (isEncryptedData(data)) return null; // Encrypted, need async decrypt
    return JSON.parse(data);
  } catch (error) {
    console.error('Failed to load keys:', error);
    return null;
  }
}

// Async version (prefers SQLite, fallback to localStorage; supports decryption)
async function loadKeysFromDb(): Promise<StoredKeys | null> {
  try {
    const data = await db.getSetting(STORAGE_KEY) ?? localStorage.getItem(STORAGE_KEY);
    if (!data) return null;

    const encKey = getEncryptionKey();
    if (isEncryptedData(data) && encKey) {
      const decrypted = await decryptData(data, encKey);
      return JSON.parse(decrypted);
    }

    // Plaintext (legacy or pre-encryption)
    if (!isEncryptedData(data)) {
      const keys = JSON.parse(data) as StoredKeys;
      // Auto-migrate: re-encrypt if encryption key is available
      if (encKey) {
        const encrypted = await encryptData(JSON.stringify(keys), encKey);
        localStorage.setItem(STORAGE_KEY, encrypted);
        db.setSetting(STORAGE_KEY, encrypted).catch(() => {});
        devLog('[useCrypto] Keys migrated to encrypted storage');
      }
      return keys;
    }

    return null;
  } catch (error) {
    console.error('Failed to load keys from db:', error);
    return loadKeys();
  }
}

// ============================================
// Session 儲存輔助函式
// ============================================

interface StoredSessions {
  [publicKeyBase64: string]: string; // Base64 encoded serialized session
}

// Promise queue serializes async session saves to prevent read-modify-write races
let _sessionSaveQueue: Promise<void> = Promise.resolve();

/**
 * Persist ratchet session to DB+localStorage.
 *
 * ⚠️ CRITICAL — 呼叫端務必 await 本函式。
 * 若 fire-and-forget，in-memory session 已推進但 DB 尚未寫入；
 * 此時 page reload/crash 會讓 DB 回退成舊狀態 → Nr/Ns 與對端不同步 → aead::Error。
 *
 * 回傳的 Promise 在本次 save 真正寫入 DB/localStorage 後 resolve。
 * 內部仍透過 `_sessionSaveQueue` 序列化以避免 read-modify-write race。
 */
function saveSession(publicKeyBase64: string, session: Session): Promise<void> {
  let serialized: Uint8Array;
  let base64: string;
  try {
    serialized = session.serialize();
    base64 = toBase64(serialized);
  } catch (error) {
    devWarn('[useCrypto] Failed to serialize session:', error);
    return Promise.reject(error);
  }

  // Chain onto queue to ensure sequential read-modify-write across sessions
  const thisSave = _sessionSaveQueue.then(async () => {
    const stored = await loadAllSessionsFromDb();
    stored[publicKeyBase64] = base64;
    const json = JSON.stringify(stored);
    const encKey = getEncryptionKey();
    if (encKey) {
      const encrypted = await encryptData(json, encKey);
      localStorage.setItem(SESSIONS_STORAGE_KEY, encrypted);
      await db.setSetting(SESSIONS_STORAGE_KEY, encrypted);
    } else {
      // Guard: refuse to downgrade encrypted sessions to plaintext
      const existing = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (existing && isEncryptedData(existing)) {
        devWarn('[useCrypto] Refusing to save plaintext sessions — currently encrypted but no encKey');
        return;
      }
      // Use ephemeral encryption (migrated to PIN-encrypted on PIN setup)
      const ephEncrypted = await encryptWithEphemeralKey(json);
      localStorage.setItem(SESSIONS_STORAGE_KEY, ephEncrypted);
      await db.setSetting(SESSIONS_STORAGE_KEY, ephEncrypted);
    }
  });

  // 鏈上一個用 .catch 包，避免一次失敗把後續全部卡住
  _sessionSaveQueue = thisSave.catch(err => {
    devWarn('[useCrypto] Failed to save session:', err);
  });

  devLog('[useCrypto] Session save queued for:', publicKeyBase64.slice(0, 16) + '...');
  return thisSave;
}

export function flushSessionWrites(): Promise<void> {
  return _sessionSaveQueue;
}

// Sync version (reads localStorage cache) - returns empty if encrypted
function loadAllSessions(): StoredSessions {
  try {
    const data = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!data) return {};
    if (isEncryptedData(data)) return {}; // Encrypted, need async version
    return JSON.parse(data);
  } catch (error) {
    console.error('[useCrypto] Failed to load sessions:', error);
    return {};
  }
}

// Async version (prefers SQLite, fallback to localStorage; supports decryption)
async function loadAllSessionsFromDb(): Promise<StoredSessions> {
  try {
    const data = await db.getSetting(SESSIONS_STORAGE_KEY) ?? localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!data) return {};

    const encKey = getEncryptionKey();
    if (isEncryptedData(data) && encKey) {
      const decrypted = await decryptData(data, encKey);
      return JSON.parse(decrypted);
    }

    if (!isEncryptedData(data)) {
      const sessions = JSON.parse(data) as StoredSessions;
      // Auto-migrate: re-encrypt if encryption key is available
      if (encKey) {
        const encrypted = await encryptData(JSON.stringify(sessions), encKey);
        localStorage.setItem(SESSIONS_STORAGE_KEY, encrypted);
        db.setSetting(SESSIONS_STORAGE_KEY, encrypted).catch(() => {});
      }
      return sessions;
    }

    return {};
  } catch {
    return loadAllSessions();
  }
}

async function restoreSessions(sessionsRef: React.MutableRefObject<Map<string, Session>>): Promise<void> {
  try {
    const stored = await loadAllSessionsFromDb();
    const entries = Object.entries(stored);

    if (entries.length === 0) {
      devLog('[useCrypto] No stored sessions to restore');
      return;
    }

    for (const [publicKeyBase64, base64Data] of entries) {
      try {
        const bytes = fromBase64(base64Data);
        const session = Session.deserialize(bytes);
        sessionsRef.current.set(publicKeyBase64, session);
        devLog('[useCrypto] Session restored for:', publicKeyBase64.slice(0, 16) + '...');
      } catch (err) {
        console.error('[useCrypto] Failed to restore session for:', publicKeyBase64.slice(0, 16), err);
        // Remove corrupted session from the already-loaded data (NOT sync loadAllSessions which returns {} for encrypted data)
        delete stored[publicKeyBase64];
        const json = JSON.stringify(stored);
        const encKey = getEncryptionKey();
        if (encKey) {
          encryptData(json, encKey).then(encrypted => {
            localStorage.setItem(SESSIONS_STORAGE_KEY, encrypted);
            db.setSetting(SESSIONS_STORAGE_KEY, encrypted).catch(() => {});
          }).catch(e => console.error('[useCrypto] Failed to persist session cleanup:', e));
        } else {
          encryptWithEphemeralKey(json).then(ephEnc => {
            localStorage.setItem(SESSIONS_STORAGE_KEY, ephEnc);
            db.setSetting(SESSIONS_STORAGE_KEY, ephEnc).catch(() => {});
          }).catch(e => console.error('[useCrypto] Failed to persist session cleanup:', e));
        }
      }
    }

    devLog('[useCrypto] Restored', sessionsRef.current.size, 'sessions');
  } catch (error) {
    console.error('[useCrypto] Failed to restore sessions:', error);
  }
}

export default useCrypto;
