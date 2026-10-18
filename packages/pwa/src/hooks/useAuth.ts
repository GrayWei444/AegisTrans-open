/**
 * useAuth — React hook 包裝 auth + devices
 *
 * 開頁面時：
 *   - 若 URL 帶 ?token=XXX → 自動 verify
 *   - 否則嘗試讀 session，並把當前裝置 ping 一次（更新 last_seen）
 */

import { useState, useEffect, useCallback } from 'react';
import {
  type Session,
  type User,
  type Device,
  requestLoginLink,
  pollEmailVerification,
  getPendingRequestId,
  clearPendingRequest,
  loginWithPassword as loginWithPasswordService,
  persistSession,
  setPassword as setPasswordService,
  getPasswordStatus,
  getCurrentSession,
  getCurrentDeviceId,
  listDevices,
  revokeDevice as revokeDeviceService,
  pingDevice,
  revocationStreak,
  isSessionExpired,
  signOut as signOutService,
  deleteAccount as deleteAccountService,
} from '../services/auth';
import { wipeLocalAccountData, hasLocalAccountData } from '../services/accountWipe';
import { getActiveServer, DEFAULT_SERVER_KEY } from '../services/serverChoice';

// CR-02 / canonical-identity：wipe-on-switch 以後端 canonical user.id 判斷（不是使用者輸入的原始 email）。
const OWNER_ID_KEY = 'aegistrans_owner_id';    // 本機資料擁有者（後端 user.id）— 換帳號判斷主鍵
const LAST_EMAIL_KEY = 'aegistrans_last_email'; // 顯示用（上次登入 email）
/** 本機資料擁有者在哪台伺服器（user.id 只在同一台伺服器內有意義）；舊安裝沒有這個 key = 預設伺服器 */
const OWNER_SERVER_KEY = 'aegistrans_owner_server';

// 裝置清單週期刷新間隔（抓其他裝置重新註冊後的新 pubkey）。
const DEVICE_REFRESH_MS = 20_000;

/**
 * 判斷本次登入是否「換帳號」。以**後端 canonical user.id** 判斷 —— 前端不做 email 正規化，用原始
 * 使用者輸入 email 會把 `John.Smith+x@gmail.com` 與 `johnsmith@gmail.com`（後端 lowercase/trim/  （oss-scan: allow — 範例地址）
 * Gmail 去 dot+tag 後其實同一帳號）誤判為換帳號 → 誤刪同帳號本機訊息/檔案。
 * fail-closed：讀不到既有 owner、但本機仍有帳號資料痕跡（身分金鑰）→ 回 true 觸發 wipe，不假定
 * 同帳號（避免新帳號繼承前帳號 IDB/SQLite 殘留）。全新裝置（無痕跡）→ 不 wipe。
 */
async function isAccountSwitch(userId: string): Promise<boolean> {
  let owner: string | null = null;
  let ownerServer: string = DEFAULT_SERVER_KEY;
  try {
    owner = localStorage.getItem(OWNER_ID_KEY);
    ownerServer = localStorage.getItem(OWNER_SERVER_KEY) ?? DEFAULT_SERVER_KEY;
  } catch { owner = null; }
  // 換了伺服器：另一台伺服器上的 user.id 不是同一個帳號，即使字串相同也當換帳號
  if (owner) return owner !== userId || ownerServer !== getActiveServer().key;
  // owner marker 缺失：檢查所有本機資料痕跡（localStorage 身分 key + IndexedDB blob + SQLite 表）。
  // 三態（review #3）:has → 換帳號;empty → 真新使用者,不 wipe;unknown（DB 開不起來/讀失敗,無法確認）
  // → **fail-closed 當換帳號**。unknown 時後續 wipe 會嘗試清 SQLite:DB 若真開不起來 → wipe throw →
  // 中止登入（不放行）→ 不會讓 B 讀到 A 的殘留;DB 之後恢復重試會看到 'has' 正常 wipe。絕不當 empty 放行。
  let state: 'has' | 'empty' | 'unknown';
  try { state = await hasLocalAccountData(); } catch { state = 'unknown'; }
  return state !== 'empty';
}

/**
 * 記住本機資料擁有者（canonical user.id）+ email（顯示用）。owner 的 setItem 若 throw 會往上拋，
 * 由 caller fail-closed（中止登入）—— owner 沒寫成會讓下次登入誤判、誤刪或漏刪本機資料。
 */
function rememberAccount(userId: string, email: string): void {
  localStorage.setItem(OWNER_ID_KEY, userId); // throw → caller 處理
  localStorage.setItem(OWNER_SERVER_KEY, getActiveServer().key); // throw → caller 處理
  try { localStorage.setItem(LAST_EMAIL_KEY, email); } catch { /* email 只顯示用，可忽略 */ }
}

interface UseAuthResult {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  jwt: string | null;
  // Login flow
  requestLink: (email: string) => Promise<boolean>;
  linkRequestedFor: string | null;
  cancelLinkRequest: () => void;
  loginWithPassword: (email: string, password: string) => Promise<boolean>;
  setPassword: (password: string, currentPassword: string | null) => Promise<boolean>;
  hasPassword: boolean | null;          // null = 還沒查; true/false = 已知
  // Devices
  devices: Device[];
  currentDeviceId: string | null;
  refreshDevices: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<boolean>;
  deleteAccount: () => Promise<boolean>;
  // Sign out
  signOut: () => void;
  clearError: () => void;
}

export function useAuth(): UseAuthResult {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkRequestedFor, setLinkRequestedFor] = useState<string | null>(
    () => getPendingRequestId()?.email ?? null   // 重新整理後仍恢復「等待中」狀態
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(getCurrentDeviceId());
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);

  // 初次載入：URL token / 既有 session / 心跳
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // StrictMode 雙跑保護：先看既有 session
      const existing = getCurrentSession();
      if (existing) {
        if (!cancelled) {
          // CR-02：建立/更新 owner 標記（同帳號冷啟動，不觸發 wipe）。mount best-effort，寫失敗
          // 不中止（已有 session）—— 下次登入的 fail-closed 會兜底。
          try { rememberAccount(existing.user.id, existing.user.email); } catch { /* mount best-effort */ }
          setSession(existing);
          // 更新心跳（撤銷檢測）—— password / devices 由「Session 變動後」effect 統一處理
          const devId = getCurrentDeviceId();
          if (devId) {
            // 只有 API 自己的撤銷回應（pingDevice → isRevocationResponse）才登出；沒網路、逾時、5xx、反向代理的 404、
            // 出錯部署的 401 都保留登入。這裡檢查一次即可（還沒有東西在跑）。
            void pingDevice(devId, existing.jwt).then((result) => {
              if (result === 'revoked' && !cancelled) {
                signOutService();
                setSession(null);
                setDevices([]);
                setCurrentDeviceId(null);
              }
            });
          }
          if (window.location.search.includes('token=')) {
            window.history.replaceState({}, '', '/');
          }
          setIsLoading(false);
        }
        return;
      }

      // 無 session：交給 AuthScreen / VerifyPage 處理 URL token / polling
      if (!cancelled) setIsLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // === Polling: 等使用者點 email link 中 ===
  useEffect(() => {
    if (session) return;                       // 已登入無需 poll
    if (!linkRequestedFor) return;             // 沒在等待狀態
    const pending = getPendingRequestId();
    if (!pending) return;

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      const result = await pollEmailVerification(pending.request_id);
      if (cancelled) return;
      if (result.status === 'verified' && result.session) {
        // CR-02 fail-closed：先判斷換帳號 → wipe 舊帳號成功 → 才 persistSession(原子寫入)。
        // session 不再由 pollEmailVerification 提前寫入 → wipe 失敗時 localStorage 不留新帳號 session。
        // （magic-link 此刻沒有 password-derived encKey，不需重 derive；reload 後走既有 ephemeral/解鎖流程）
        const loggedInEmail = result.session.user.email;
        const switching = await isAccountSwitch(result.session.user.id);
        if (switching) {
          if (intervalId) clearInterval(intervalId);
          try {
            await wipeLocalAccountData();
          } catch (e) {
            console.error('[useAuth] account wipe failed, aborting switch:', e);
            // wipe 失敗：不 persist session；清掉 pending(token 已被後端消費，續 poll 只會卡 consumed)，
            // 要求使用者重新申請連結。
            clearPendingRequest();
            setLinkRequestedFor(null);
            setError('無法清除前一個帳號的本機資料，為保護隱私已中止切換，請重試');
            return;
          }
        }
        // 全部成功 → 原子寫入 owner marker + session（最後一步）。失敗（quota/私密模式）→ 清掉半寫入 +
        // pending，回報可重試（owner 沒寫成會讓下次登入誤判換帳號；magic-link 此刻沒寫 encKey，不需清 key）。
        try {
          rememberAccount(result.session.user.id, loggedInEmail);
          persistSession(result.session);
        } catch (err) {
          console.error('[useAuth] final persist failed:', err);
          try { localStorage.removeItem(OWNER_ID_KEY); localStorage.removeItem(OWNER_SERVER_KEY); localStorage.removeItem('aegistrans_session'); } catch { /* */ }
          clearPendingRequest();
          setLinkRequestedFor(null);
          if (intervalId) clearInterval(intervalId);
          setError('登入儲存失敗（裝置儲存空間或權限問題），請重新申請連結');
          return;
        }
        clearPendingRequest();   // CR-03：登入完成清掉 request_id，下次登入用新的（不跨登入沿用）
        if (switching) {
          try { window.location.reload(); } catch { /* ignore */ }
          return;
        }
        setSession(result.session);
        setLinkRequestedFor(null);
        if (intervalId) clearInterval(intervalId);
      } else if (result.status === 'expired' || result.status === 'not_found') {
        // 連結過期或被清掉 → 重置狀態
        clearPendingRequest();
        setLinkRequestedFor(null);
        setError('登入連結已過期或失效，請重新申請');
        if (intervalId) clearInterval(intervalId);
      }
      // pending / error / consumed → 持續輪詢
    };

    // 立刻跑一次（重新整理頁面後恢復狀態的情境）+ 每 2s 一次
    void tick();
    intervalId = setInterval(tick, 2000);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [session, linkRequestedFor]);

  // === Session 變動後：抓 password 狀態 + devices 列表 ===
  useEffect(() => {
    if (!session) {
      setHasPassword(null);
      setDevices([]);
      return;
    }
    let cancelled = false;
    void getPasswordStatus(session.jwt).then((s) => {
      if (!cancelled) setHasPassword(s.has_password);
    });
    // 週期刷新裝置清單，抓「同帳號其他裝置重新註冊後的新 pubkey」。
    // 全新安裝/重裝後每台都會換新 keypair；先登入的裝置若只在登入時抓一次，會一直用舊 pubkey
    // 訂 presence + 傳訊 → 看不到對方上線、也傳不出去（2026-07-12 log 實證：Mac 訂到 iPhone 舊
    // pubkey 的 presence topic）。只有 id/pubkey 真的變了才 setDevices，避免每輪重渲染 / 重配對。
    const sig = (list: Device[]) => list.map((d) => `${d.id}:${d.pubkey ?? ''}`).sort().join('|');
    // 連續兩次週期檢查都是 API 明確的「已撤銷」才登出（審查 MEDIUM-2：出錯的部署不能把開著的 App 全部登出）
    const revoked = revocationStreak(2);
    const fetchDevices = () => {
      void listDevices(session.jwt)
        .then((list) => {
          revoked('ok');
          if (!cancelled) setDevices((prev) => (sig(prev) === sig(list) ? prev : list));
        })
        .catch(() => {
          if (cancelled) return;
          // session 自己的 30 天效期過了：伺服器只回 401 "Invalid or expired token"（不是撤銷回應）→ 以前當成連不到，開著的
          //   App 永遠不登出、MQTT 也換不到 token（對應 TofuTalk 749e349，審查 HIGH-1）。過期的 JWT 不會再被接受 → 直接走一般登出，不用等兩次。
          if (isSessionExpired(session)) {
            signOutService();
            setSession(null);
            setDevices([]);
            setCurrentDeviceId(null);
            return;
          }
          // 暫時性網路錯誤：保留上一份清單，下輪再試。但若是「這台已被撤銷」（API 自己的撤銷回應，連續兩次）→ 登出。
          //   MQTT 踢裝置訊號整條沒接（伺服器不發 aegis/device/+/kicked、App 也沒人聽 aegis:device-kick-signal），
          //   被撤銷的裝置要到下次開 App 才登出（對應 TofuTalk 96a54d7 + 7c7251e）
          const devId = getCurrentDeviceId();
          if (!devId || cancelled) return;
          void pingDevice(devId, session.jwt).then((result) => {
            if (cancelled || !revoked(result)) return;
            signOutService();
            setSession(null);
            setDevices([]);
            setCurrentDeviceId(null);
          });
        });
    };
    fetchDevices();
    const iv = setInterval(fetchDevices, DEVICE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(iv); };
  }, [session]);

  const requestLink = useCallback(async (email: string) => {
    setError(null);
    const result = await requestLoginLink(email);
    if (result.ok) {
      setLinkRequestedFor(email);
      return true;
    }
    setError(result.error);
    return false;
  }, []);

  const cancelLinkRequest = useCallback(() => {
    clearPendingRequest();
    setLinkRequestedFor(null);
    setError(null);
  }, []);

  const loginWithPassword = useCallback(async (email: string, password: string) => {
    setError(null);
    const result = await loginWithPasswordService(email, password);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    // CR-02 fail-closed 正確順序：驗證成功 → 判斷換帳號 → wipe 舊帳號 → 建立新 encKey → 最後才
    // persistSession(原子)。任一步失敗都不得留下新帳號 session（loginWithPasswordService 已不再
    // 提前寫 SESSION_KEY / encKey）。只有「驗證成功」後才判斷換帳號（避免打錯密碼也清掉舊帳號）。
    const switching = await isAccountSwitch(result.session.user.id);
    if (switching) {
      try {
        await wipeLocalAccountData();
      } catch (e) {
        console.error('[useAuth] account wipe failed, aborting switch:', e);
        setError('無法清除前一個帳號的本機資料，為保護隱私已中止切換，請重試');
        return false;
      }
    }
    // 建立並快取 encKey（跨 launch 加密持久化；否則走 ephemeral random key，重啟後 ratchet state
    // 解不出 → 訊息其他裝置收不到）。換帳號：wipe 已清舊 salt+encKey，同密碼重 derive(新 salt)；
    // 非換帳號：沿用既有 salt。失敗即 fail-closed：不 persist session（不留無法解密的帳號）。
    try {
      const { deriveEncryptionKey, setEncryptionKey } = await import('../services/keyEncryption');
      await setEncryptionKey(await deriveEncryptionKey(password, switching ? { isInitialSetup: true } : undefined));
    } catch (err) {
      console.error('[useAuth] set encKey failed, aborting login:', err);
      setError('無法建立加密金鑰，請重試');
      return false;
    }
    // 全部成功 → 原子寫入 owner marker + session（最後一步）。任一 throw（quota / 私密模式）→ 清掉
    // 半寫入的 owner/session + 新 encKey，回報可重試（不留半完成狀態；owner 沒寫成尤其危險，會讓
    // 下次登入誤判換帳號）。
    try {
      rememberAccount(result.session.user.id, email);
      persistSession(result.session);
    } catch (err) {
      console.error('[useAuth] final persist failed:', err);
      try { localStorage.removeItem(OWNER_ID_KEY); localStorage.removeItem(OWNER_SERVER_KEY); localStorage.removeItem('aegistrans_session'); } catch { /* */ }
      try {
        const { clearEncryptionKey } = await import('../services/keyEncryption');
        await clearEncryptionKey();
      } catch { /* best-effort 清理 */ }
      setError('登入儲存失敗（裝置儲存空間或權限問題），請重試');
      return false;
    }
    if (switching) {
      // reload 讓 useCrypto in-memory（identity / sessions ref）從零開始；session 已在 localStorage。
      try { window.location.reload(); } catch { /* ignore */ }
      return true;
    }
    setSession(result.session);
    setLinkRequestedFor(null);
    // password / devices 由「Session 變動後」effect 統一抓
    return true;
  }, []);

  const setPassword = useCallback(async (password: string, currentPassword: string | null) => {
    if (!session) return false;
    const ok = await setPasswordService(session.jwt, password, currentPassword);
    if (ok) setHasPassword(true);
    return ok;
  }, [session]);

  const refreshDevices = useCallback(async () => {
    if (!session) return;
    let list: Device[];
    try {
      list = await listDevices(session.jwt);
    } catch {
      return;   // 暫時抓不到：保留上一份清單，下次 roster ping／週期刷新再試
    }
    setDevices(list);
    setCurrentDeviceId(getCurrentDeviceId());
  }, [session]);

  const revokeDevice = useCallback(async (deviceId: string) => {
    if (!session) return false;
    // 在呼叫 backend 之前把 device row 留下來，需要 pubkey 才能 dispatch group key 給「剩餘」裝置
    const targetDevice = devices.find((d) => d.id === deviceId);
    const remainingPubkeys = devices
      .filter((d) => d.id !== deviceId && d.pubkey)
      .map((d) => d.pubkey as string);

    const ok = await revokeDeviceService(deviceId, session.jwt);
    if (ok) {
      // 若撤銷自己 → service 已清 session，這邊把 React state 同步
      if (deviceId === getCurrentDeviceId() || !getCurrentSession()) {
        setSession(null);
        setDevices([]);
        setCurrentDeviceId(null);
        setLinkRequestedFor(null);
      } else {
        setDevices((prev) => prev.filter((d) => d.id !== deviceId));
      }
      // 觸發 group key rotation：fire window event 讓 App.tsx（有 crypto context）處理實際 dispatch
      try {
        window.dispatchEvent(new CustomEvent('aegistrans:deviceRevoked', {
          detail: {
            revokedDeviceId: deviceId,
            revokedPubkey: targetDevice?.pubkey ?? null,
            remainingPubkeys,
          },
        }));
      } catch { /* ignore */ }
    }
    return ok;
  }, [session, devices]);

  const deleteAccount = useCallback(async () => {
    if (!session) return false;
    const ok = await deleteAccountService(session.jwt);
    if (ok) {
      setSession(null);
      setDevices([]);
      setCurrentDeviceId(null);
      setLinkRequestedFor(null);
      // CR-02：deleteAccountService 只清 localStorage，沒清 SQLite/blob → 補上 wipe（訊息/檔案/金鑰）。
      // 帳號已在 server 端刪除，此處無「帳號 B 繼承 A」風險（沒有新帳號正在登入）；若清除失敗，
      // 殘留是「已刪帳號」的資料，且下次任何帳號登入時的 fail-closed wipe 會再擋一次。故記錄錯誤後仍繼續。
      try {
        await wipeLocalAccountData();
      } catch (e) {
        console.error('[useAuth] local wipe after account delete incomplete:', e);
        setError('帳號已刪除，但本機資料未完全清除；下次登入時會再嘗試清除');
      }
      // 強制 reload 讓 React tree 從零開始（避免 useCrypto state 殘留）
      try { window.location.reload(); } catch { /* ignore */ }
    }
    return ok;
  }, [session]);

  const signOut = useCallback(() => {
    signOutService();
    setSession(null);
    setDevices([]);
    setCurrentDeviceId(null);
    setLinkRequestedFor(null);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    user: session?.user ?? null,
    isLoading,
    error,
    jwt: session?.jwt ?? null,
    requestLink,
    linkRequestedFor,
    cancelLinkRequest,
    loginWithPassword,
    setPassword,
    hasPassword,
    devices,
    currentDeviceId,
    refreshDevices,
    revokeDevice,
    deleteAccount,
    signOut,
    clearError,
  };
}
