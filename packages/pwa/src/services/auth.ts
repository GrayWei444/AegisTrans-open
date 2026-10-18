/**
 * AegisTrans Auth Service — Email magic link + 我的裝置群組
 *
 * Backend: {apiBase()}/aegistrans/auth/*（api/aegistrans_routes.py）
 *   POST   /email/request           body: {email}
 *   GET    /email/verify            query: token
 *   GET    /me                      header: Bearer <jwt>
 *   POST   /devices/register        body: {label, user_agent}
 *   GET    /devices
 *   POST   /devices/{id}/ping
 *   DELETE /devices/{id}
 */

import { apiBase } from './apiBase';
import { computeMachineFingerprint } from './fingerprint';
import { clearEncryptionKey } from './keyEncryption';
import { deviceListStamp } from './accountDevices';
import { SERVER_STORAGE_KEY } from './serverChoice';

const SESSION_KEY = 'aegistrans_session';
const DEVICE_KEY = 'aegistrans_device_id';
const API_BASE = `${apiBase()}/aegistrans/auth`;

export interface User {
  id: string;
  email: string;
}

export interface Session {
  user: User;
  jwt: string;
  expiresAt: number;
}

export interface Device {
  id: string;
  label: string;
  user_agent: string | null;
  pubkey: string | null;
  first_seen_at: number;
  last_seen_at: number;
}

// ===== Password login (C-2) =====

/**
 * 原子寫入登入 session（CR-02 fail-closed 的最後一步）。
 * 必須在「判斷換帳號 → wipe 舊帳號 → 建立新 encKey」全部成功之後才呼叫；任何前一步失敗都
 * 不得呼叫此函式，否則 localStorage 會留下新帳號 session，重開 app 即完成未授權的帳號切換。
 */
export function persistSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function loginWithPassword(email: string, password: string): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  try {
    const resp = await fetch(`${API_BASE}/password/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.error || '登入失敗' };
    const jwt: string = data.token;
    const session: Session = {
      user: data.user,
      jwt,
      expiresAt: parseJwtExp(jwt) ?? Math.floor(Date.now() / 1000) + 30 * 86400,
    };
    // ⚠️ CR-02 fail-closed：session 與 encryption key 的持久化「不」在這裡做。
    // 交給 caller(useAuth)在「判斷是否換帳號 → wipe 舊帳號成功 → 建立新 encKey」之後才
    // 原子寫入。若在此提前寫 SESSION_KEY / encKey,wipe 失敗時 caller 雖中止切換,localStorage
    // 仍留著新帳號 session → 重開 app 就載入新帳號(可能帶舊帳號殘留資料)。encKey 由 useAuth
    // 用同一組 password derive(換帳號用新 salt),確保跨 launch 加密持久化正確。
    return { ok: true, session };
  } catch {
    return { ok: false, error: '網路錯誤' };
  }
}

/**
 * 設定 / 修改密碼。C-3：已有密碼者必須 current_password；首次設定 currentPassword 傳 null。
 */
export async function setPassword(jwt: string, password: string, currentPassword: string | null = null): Promise<boolean> {
  try {
    const postPassword = async (): Promise<boolean> => {
      const body: { password: string; current_password?: string } = { password };
      if (currentPassword) body.current_password = currentPassword;
      const resp = await fetch(`${API_BASE}/password/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify(body),
      });
      return resp.ok;
    };

    const { deriveEncryptionKey, setEncryptionKey, rekeyProtectedRecords } = await import('./keyEncryption');

    if (currentPassword) {
      // CR-04 原子式換金鑰 + 兩端順序修復：local-first，server 後寫，server 失敗則回滾 local。
      //   舊做法 server 先寫、local 後 rekey：local rekey 失敗時 server 密碼已改 → 下次登入用新密碼
      //   derive newKey，但本機資料還在 oldKey 下 → 解不開、形同失去資料。
      //   現做法：先在本機 rekey（純本地、可靠回滾），成功才 POST；POST 失敗就把 local rekey 倒回去。
      const oldKey = await deriveEncryptionKey(currentPassword); // 與 newKey 共用同一個 salt
      const newKey = await deriveEncryptionKey(password);
      try {
        await rekeyProtectedRecords(oldKey, newKey);
        await setEncryptionKey(newKey);
      } catch (err) {
        console.error('[auth] CR-04 rekey FAILED — local secrets preserved (server untouched):', err);
        return false; // server 還沒動，本機未切 key → 兩端一致（仍是舊密碼）
      }
      if (await postPassword()) return true;
      // server 寫入失敗 → 回滾 local 到舊密碼，保持與 server 一致
      try {
        await rekeyProtectedRecords(newKey, oldKey);
        await setEncryptionKey(oldKey);
      } catch (rbErr) {
        console.error('[auth] CR-04 rollback FAILED after server error — local now under new key, server under old:', rbErr);
      }
      return false;
    }

    // 首次設定密碼：無既有加密資料可回滾，server 先寫成功才 set 本機 key（一致性更簡單）。
    if (!(await postPassword())) return false;
    try {
      const encKey = await deriveEncryptionKey(password, { isInitialSetup: true });
      await setEncryptionKey(encKey);
    } catch (err) {
      console.error('[auth] Failed to set encryption key after initial setPassword:', err);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 忘記密碼重設：剛走完 magic-link（email 已驗）後設新密碼，不需舊密碼。
 * 後端 /password/reset 會驗「近 15 分鐘內有 verified magic-link」才放行。
 * 成功後 derive encKey from 新密碼（同 setPassword）；舊本機 key 用舊 encKey 加密、
 * 新 encKey 解不開 → 該裝置會重生隨機身分（= 忘記密碼=該裝置重新配對，符合設計）。
 */
export async function resetPassword(jwt: string, password: string): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/password/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
      body: JSON.stringify({ password }),
    });
    if (!resp.ok) return false;
    try {
      const { deriveEncryptionKey, setEncryptionKey } = await import('./keyEncryption');
      const encKey = await deriveEncryptionKey(password, { isInitialSetup: true });
      await setEncryptionKey(encKey);
    } catch (err) {
      console.error('[auth] Failed to set encryption key after resetPassword:', err);
    }
    return true;
  } catch {
    return false;
  }
}

export async function getPasswordStatus(jwt: string): Promise<{ has_password: boolean }> {
  try {
    const resp = await fetch(`${API_BASE}/password/status`, {
      headers: { 'Authorization': `Bearer ${jwt}` },
    });
    if (!resp.ok) return { has_password: false };
    return await resp.json();
  } catch {
    return { has_password: false };
  }
}

// ===== Email magic link (polling-based) =====
// Flow:
//   1. requestLoginLink(email) → 生成 request_id（保存 localStorage）+ 後端寄信
//   2. 原裝置定時 pollEmailVerification(request_id) → 等使用者點 email 連結
//   3. 任何裝置點連結 → markEmailVerified(token) → 後端標 verified_at
//   4. 原裝置 poll 偵測 verified → 拿到 JWT → 完成登入

const REQUEST_ID_KEY = 'aegistrans_pending_request_id';
const REQUEST_EMAIL_KEY = 'aegistrans_pending_email';

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  // Fallback
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getPendingRequestId(): { request_id: string; email: string } | null {
  const id = localStorage.getItem(REQUEST_ID_KEY);
  const email = localStorage.getItem(REQUEST_EMAIL_KEY);
  return id && email ? { request_id: id, email } : null;
}

export function clearPendingRequest(): void {
  localStorage.removeItem(REQUEST_ID_KEY);
  localStorage.removeItem(REQUEST_EMAIL_KEY);
}

/** Build a human-readable client label so the email/verify page can display
 *  「此裝置正在請求登入：[client_label]」— defensive UX for magic link CSRF (#1).
 *  Picks UA model + OS hint + locale; truncate to 120 chars (server enforces too). */
function buildClientLabel(): string {
  const ua = navigator.userAgent || '';
  const lang = navigator.language || '';
  // 抓 OS hint
  let os = 'Unknown';
  if (/Win/i.test(ua)) os = 'Windows';
  else if (/Mac/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua) && !/Android/i.test(ua)) os = 'Linux';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iP(hone|ad|od)/i.test(ua)) os = 'iOS';
  // 抓 browser
  let br = 'Browser';
  if (/Edg\//i.test(ua)) br = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) br = 'Chrome';
  else if (/Firefox\//i.test(ua)) br = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) br = 'Safari';
  return `${os} · ${br} · ${lang}`.slice(0, 120);
}

export async function requestLoginLink(email: string): Promise<{ ok: true } | { ok: false; error: string }> {
  // CR-03：同一個 email 的重送沿用原 request_id。server 不再 rebind（防 takeover），
  // 沿用原 request_id 才能讓「按兩下寄送」的後續 poll 仍對得到原 token。
  // 不同 email / 無 pending → 生成新的。
  const pending = getPendingRequestId();
  const request_id = pending && pending.email === email ? pending.request_id : generateRequestId();
  const client_label = buildClientLabel();
  try {
    const resp = await fetch(`${API_BASE}/email/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, request_id, client_label }),
    });
    if (resp.status === 400) return { ok: false, error: 'Email 格式不正確' };
    if (!resp.ok) return { ok: false, error: `寄信失敗（${resp.status}）。請稍後再試。` };
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: '寄信失敗，請稍後再試。' };
    // 成功送出 → 記住 request_id 給 polling 用
    localStorage.setItem(REQUEST_ID_KEY, request_id);
    localStorage.setItem(REQUEST_EMAIL_KEY, email);
    return { ok: true };
  } catch {
    return { ok: false, error: '網路錯誤。請檢查連線後再試。' };
  }
}

export type PollStatus = 'pending' | 'verified' | 'expired' | 'not_found' | 'consumed' | 'error';

export interface PollResult {
  status: PollStatus;
  session?: Session;
}

/** 原裝置輪詢 email 是否已被點擊驗證 */
export async function pollEmailVerification(request_id: string): Promise<PollResult> {
  try {
    const resp = await fetch(`${API_BASE}/email/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id }),
    });
    if (!resp.ok) return { status: 'error' };
    const data = await resp.json();
    if (data.status !== 'verified') {
      return { status: data.status as PollStatus };
    }
    // verified → 已拿到 JWT
    const session: Session = {
      user: data.user,
      jwt: data.token,
      expiresAt: parseJwtExp(data.token) ?? Math.floor(Date.now() / 1000) + 30 * 86400,
    };
    // ⚠️ CR-02 fail-closed：持久化(SESSION_KEY 寫入 + clearPendingRequest)交給 caller(useAuth)
    // 在 wipe-on-switch 成功後才做,避免 wipe 失敗仍留下新帳號 session(見 loginWithPassword 註解)。
    return { status: 'verified', session };
  } catch {
    return { status: 'error' };
  }
}

/**
 * 點擊 email 連結那台裝置呼叫，分兩階段（C-3 防 CSRF login takeover）：
 *
 *   1. 預覽（confirmed=false）：取得對應的 email + client_label。**不會**標 verified_at。
 *      VerifyPage 用這個資料顯示「[Linux Chrome] 正在請求登入，確認嗎？」
 *   2. 確認（confirmed=true）：使用者按下「確認登入」按鈕後再呼叫。這次才標 verified_at，
 *      原裝置才能透過 polling 取得 JWT。
 *
 * 舊行為（任何人造訪 URL 即 silently 標 verified）= attacker 持有 request_id 即可竊取 victim
 * JWT。新行為要求人類使用者實際看到 client_label 才能放行。
 */
export interface VerifyPreviewResult {
  ok: true;
  email: string;
  client_label: string | null;
  confirmed: boolean;
}
export interface VerifyConfirmFailed {
  ok: false;
  error: string;
}

export async function previewMagicToken(token: string): Promise<VerifyPreviewResult | VerifyConfirmFailed> {
  try {
    const resp = await fetch(`${API_BASE}/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, confirmed: false }),
    });
    if (!resp.ok) return { ok: false, error: '驗證失敗' };
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.error || '連結無效或已過期' };
    return {
      ok: true,
      email: data.email,
      client_label: data.client_label ?? null,
      confirmed: !!data.confirmed,
    };
  } catch {
    return { ok: false, error: '網路錯誤' };
  }
}

export async function confirmMagicToken(token: string): Promise<VerifyPreviewResult | VerifyConfirmFailed> {
  try {
    const resp = await fetch(`${API_BASE}/email/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, confirmed: true }),
    });
    if (!resp.ok) return { ok: false, error: '驗證失敗' };
    const data = await resp.json();
    if (!data.ok) return { ok: false, error: data.error || '連結無效或已過期' };
    return {
      ok: true,
      email: data.email,
      client_label: data.client_label ?? null,
      confirmed: !!data.confirmed,
    };
  } catch {
    return { ok: false, error: '網路錯誤' };
  }
}

/** @deprecated 用 previewMagicToken + confirmMagicToken 兩階段；保留 export 避免 build 破。 */
export async function markEmailVerified(token: string): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const r = await confirmMagicToken(token);
  if (r.ok) return { ok: true, email: r.email };
  return { ok: false, error: r.error };
}

// 舊 verifyToken 保留為 deprecated wrapper（避免破壞 import）
export async function verifyToken(_token: string): Promise<{ ok: false; error: string }> {
  return { ok: false, error: '此流程已改為輪詢式，請從原本登入畫面繼續' };
}

export function getCurrentSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    if (session.expiresAt < Math.floor(Date.now() / 1000)) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(DEVICE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function signOut() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(DEVICE_KEY);
  // CR-02：登出時清掉 in-memory 加密金鑰 + 其 IDB 快取 + sessionStorage marker（不刪本機資料
  // 本身 —— 同帳號再登入仍保留歷史；換帳號才由 wipeLocalAccountData 全清）。
  // 同帳號登出 best-effort：in-memory key 已同步清空；IDB 刪除失敗不擋登出（無跨帳號 race）。
  clearEncryptionKey().catch(() => { /* best-effort on same-account signout */ });
}

// ===== Devices (我的裝置群組) =====

export function getCurrentDeviceId(): string | null {
  return localStorage.getItem(DEVICE_KEY);
}

export type RegisterDeviceResult =
  | { ok: true; device: Device | null }      // 成功 INSERT 或 dedupe 命中（device），或 ping 通過 (null)
  /** currentDeviceId：這個 session 綁定的那台（撤銷它＝撤銷正在登入的 session；替換畫面標成「本機」）；舊 API 沒有＝null */
  | { ok: false; reason: 'device_limit_exceeded'; tier: string; tierLimit: number; deviceCount: number; devices: Device[]; currentDeviceId: string | null }
  | { ok: false; reason: 'hard_cap'; message: string }
  /** 連不到、逾時、5xx、429、不是撤銷回應的 401（例如部署出錯的 JWT secret）、不是 JSON 的錯誤頁：保留登入，稍後重試 */
  | { ok: false; reason: 'network' }
  /** API 自己的撤銷回應（isRevocationResponse，跟 session 檢查同一套規則）：這台已被撤銷 → 登出 */
  | { ok: false; reason: 'revoked' }
  /** 沒成功、且 session 自己的效期已過（isSessionExpired）：過期的 JWT 不會再被接受 → 登出，不重試（對應 TofuTalk 749e349，審查 HIGH-1） */
  | { ok: false; reason: 'expired' }
  /** 其他 4xx：重試也不會好 → 顯示錯誤，不重試（對應 TofuTalk ae21506：以前一律當成網路錯一直重試） */
  | { ok: false; reason: 'rejected'; status: number; message: string };

/** 註冊失敗的分類（409／422 以外） */
async function registerFailure(resp: Response): Promise<RegisterDeviceResult> {
  if (resp.status >= 500 || resp.status === 429) return { ok: false, reason: 'network' };
  if (resp.status === 401) return (await isRevocationResponse(resp)) ? { ok: false, reason: 'revoked' } : { ok: false, reason: 'network' };
  const body = await jsonBody(resp);
  if (body === NOT_JSON) return { ok: false, reason: 'network' };
  const detail = (body as { detail?: unknown } | null)?.detail ?? null;
  if (resp.status === 404 && detail === ROUTE_NOT_FOUND) return { ok: false, reason: 'network' };
  return registerRejected(resp.status, detail);
}

/**
 * FastAPI 對沒有這條路由的回答（404 {"detail":"Not Found"}）。aegistrans 路由掛在共用的 AegisTalk API 行程裡，
 * aegistrans_routes.py 匯入失敗（例如部署漏了這個檔）就整組不掛（AegisTalk api/main.py 的 _HAS_AEGISTRANS），
 * 每個 /aegistrans/* 都回這個。/devices/register 自己從不回 404 → 這是部署狀態，不是這台裝置的問題：當成暫時性
 * （network，退避重試），重新部署後自己好，不停在「無法完成註冊」（AegisTrans 審查 M3）。
 */
const ROUTE_NOT_FOUND = 'Not Found';

const NOT_JSON = Symbol('not json');

/**
 * 錯誤回應的 JSON 內容；不是 JSON → NOT_JSON。API（FastAPI）的錯誤一律是 JSON：不是 JSON 的錯誤頁（部署中反向代理／WAF 的
 * HTML 404／403、空內容）不是 API 的回答，當成暫時性（network，退避重試），不能讓開機流程停在「無法註冊」（對應 TofuTalk
 * 2b55267，審查 LOW-3／AegisTrans 審查 M3）。
 */
async function jsonBody(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return NOT_JSON;
  }
}

function registerRejected(status: number, detail: unknown): RegisterDeviceResult {
  const text = typeof detail === 'string' && detail ? `HTTP ${status}：${detail.slice(0, 200)}` : `HTTP ${status}`;
  return { ok: false, reason: 'rejected', status, message: text };
}

export async function registerCurrentDevice(jwt: string, pubkey?: string | null): Promise<RegisterDeviceResult> {
  const result = await registerDevice(jwt, pubkey);
  // session 到期後伺服器只回 401 "Invalid or expired token"（verify_jwt 在查 session 之前就擋掉），跟部署出錯的 JWT secret
  //   同一個回答 → 以前一律當成網路錯，開機流程無限重試（審查 HIGH-1）。本機效期已過就是到期（沒有續期，重試不會好）。
  if (!result.ok && result.reason === 'network' && isSessionExpired({ jwt })) return { ok: false, reason: 'expired' };
  return result;
}

async function registerDevice(jwt: string, pubkey?: string | null): Promise<RegisterDeviceResult> {
  // 不再走 ping shortcut — 每次 boot 都打 /register，server 端用 fingerprint_hash dedupe。
  // 原因：ping shortcut 會 bypass tier-limit check，導致「app 開起來時超限不會被擋」。
  // 改成永遠呼叫 register 後：
  //   - 同物理機 → server fingerprint_hash 命中 → 回原 row（無 INSERT，無計數成長）
  //   - 真的新裝置 → 計數 +1，撞上限就 409 → DeviceLimitGate
  const label = detectDeviceLabel();
  // Phase B：帶 fingerprint_hash 給 server 做穩定 dedupe（pm clear / 重裝後仍能對到同一 row）
  let fingerprint_hash: string | null = null;
  try {
    fingerprint_hash = await computeMachineFingerprint();
  } catch {
    // 算不出來不擋登入；server 會 fallback 用 pubkey dedupe
  }
  try {
    // 卡住的請求會讓開機流程永遠等在這裡（不會走到重試）；逾時算 network → 重試（對應 TofuTalk ae21506）
    return await withRequestTimeout<RegisterDeviceResult>(REGISTER_TIMEOUT_MS, async (signal) => {
      const resp = await fetch(`${API_BASE}/devices/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          label,
          user_agent: navigator.userAgent.slice(0, 400),
          pubkey: pubkey ?? null,
          fingerprint_hash,
        }),
        signal,
      });
      if (resp.status === 409) {
        // 裝置數真的超過 tier 上限 — 解析 device list 給 gate UI
        const data = await jsonBody(resp);
        if (data === NOT_JSON) return { ok: false, reason: 'network' };   // 代理的錯誤頁，不是 API 的 409
        const detail = ((data as { detail?: unknown } | null)?.detail ?? data) as
          { error?: unknown; tier?: unknown; tier_limit?: unknown; device_count?: unknown; devices?: unknown; current_device_id?: unknown } | string | null;
        if (detail && typeof detail === 'object' && detail.error === 'device_limit_exceeded') {
          return {
            ok: false,
            reason: 'device_limit_exceeded',
            tier: String(detail.tier ?? 'free'),
            tierLimit: Number(detail.tier_limit ?? 2),
            deviceCount: Number(detail.device_count ?? 0),
            devices: Array.isArray(detail.devices) ? detail.devices : [],
            currentDeviceId: typeof detail.current_device_id === 'string' ? detail.current_device_id : null,
          };
        }
        return registerRejected(409, detail);
      }
      if (resp.status === 422) {
        const data = await jsonBody(resp);
        if (data === NOT_JSON) return { ok: false, reason: 'network' };   // 代理的錯誤頁，不是 API 的 422
        return { ok: false, reason: 'hard_cap', message: String((data as { detail?: unknown } | null)?.detail ?? '已達絕對裝置上限') };
      }
      if (!resp.ok) return await registerFailure(resp);
      const dev: Device = await resp.json();
      localStorage.setItem(DEVICE_KEY, dev.id);
      return { ok: true, device: dev };
    });
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/** 補登/更新裝置的 Ed25519 公鑰（補登 keypair 用）。 */
export async function setDevicePubkey(deviceId: string, pubkey: string, jwt: string): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/devices/${encodeURIComponent(deviceId)}/pubkey`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
      },
      body: JSON.stringify({ pubkey }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 請求逾時：AbortController＋計時器，不用 AbortSignal.timeout —— iOS 15（部署目標）的 WebView 沒有後者，
 * 呼叫會丟錯；TofuTalk 的「沒有就不設」在 iOS 15 等於沒有逾時。計時器涵蓋讀 body，run 結束（成功或失敗）就清掉。
 */
async function withRequestTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** GET /devices 逾時：「仍是本帳號裝置」檢查等它（對應 TofuTalk 06fe74a，審查 HIGH-2） */
const LIST_DEVICES_TIMEOUT_MS = 10_000;
/** POST /devices/register 逾時（對應 TofuTalk ae21506） */
const REGISTER_TIMEOUT_MS = 20_000;

/**
 * 失敗（非 2xx、斷網、逾時、body 讀不出來）一律丟錯，不回 []：空清單會被當成「帳號沒有其他裝置」——
 * 畫面清空、撤銷時「剩餘裝置」算成空、新金鑰誰都沒收到。呼叫端自己決定保留上一份／拒絕／略過。
 */
export async function listDevices(jwt: string): Promise<Device[]> {
  let devices: Device[];
  const startedAt = deviceListStamp();
  try {
    devices = await withRequestTimeout(LIST_DEVICES_TIMEOUT_MS, async (signal) => {
      const resp = await fetch(`${API_BASE}/devices`, {
        headers: { 'Authorization': `Bearer ${jwt}` },
        signal,
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return data.devices ?? [];
    });
  } catch (err) {
    throw new Error(`device list unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const listener of deviceListListeners) {
    try { listener(devices, { startedAt }); } catch { /* 單一 listener 出錯不影響清單 */ }
  }
  return devices;
}

/**
 * startedAt：這次請求開始時的 deviceListStamp()（「仍是本帳號裝置」檢查的單調時鐘，不是系統時間）：不同來源的清單依開始
 * 先後套用，晚回來的舊清單不蓋掉新的；系統時間往回調也不會讓之後的清單被當成舊的（對應 TofuTalk cf8f03d，審查 round-3 MEDIUM-2）
 */
type DeviceListListener = (devices: readonly Device[], meta: { startedAt: number }) => void;
const deviceListListeners = new Set<DeviceListListener>();

/**
 * 每次 GET /devices 成功（不論是週期刷新、帳號裝置檢查、開機或撤銷流程抓的）都通知：
 * 刪 outbox 這類不可逆的清理要看「連續兩次成功的清單」，不能只看一次快照（對應 TofuTalk a08cc93，審查 LOW）。
 */
export function onDeviceListFetched(listener: DeviceListListener): () => void {
  deviceListListeners.add(listener);
  return () => { deviceListListeners.delete(listener); };
}

export async function revokeDevice(deviceId: string, jwt: string): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${jwt}` },
    });
    if (resp.ok && deviceId === getCurrentDeviceId()) {
      // 撤銷自己 = 形同登出
      signOut();
    }
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 刪除帳號（GDPR 資料刪除權）。
 *
 * Backend cascade 刪除 server-side 所有資料：
 *   - aegistrans_users（user 本身）
 *   - aegistrans_devices（所有 device rows）
 *   - aegistrans_magic_tokens
 *
 * **不影響**本機資料（IndexedDB / SQLite）；frontend 應該在成功後自行
 * `signOut()` + 清 localStorage。
 */
export async function deleteAccount(jwt: string): Promise<boolean> {
  try {
    const resp = await fetch(`${API_BASE}/users/me`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${jwt}` },
    });
    if (resp.ok) {
      signOut();
      // 清本機 storage（讓 useCrypto / 訊息歷史下次登入是全新狀態）；伺服器選擇屬於這個安裝、不屬於帳號，保留
      try {
        const server = localStorage.getItem(SERVER_STORAGE_KEY);
        localStorage.clear();
        if (server) localStorage.setItem(SERVER_STORAGE_KEY, server);
      } catch { /* ignore */ }
    }
    return resp.ok;
  } catch {
    return false;
  }
}

/** 裝置心跳逾時：請求卡住時當作連不上，不等到天荒地老 */
const PING_TIMEOUT_MS = 15_000;

/**
 * API 自己的「這個 session／裝置已失效」回應（api/aegistrans_routes.py 的 _require_user 與 ping；對應 TofuTalk
 * 7c7251e，審查 MEDIUM-2）。只有這些會登出：一次出錯的部署（JWT secret 設錯 → 401 "Invalid or expired token"）、
 * 共用 AegisTalk 行程沒掛上 aegistrans 路由或反向代理的 404 "Not Found"／HTML、403 都不算。
 */
const REVOCATION_DETAILS: Readonly<Record<number, readonly string[]>> = {
  401: ['Device revoked', 'Session revoked or expired', 'Account no longer exists', 'Legacy session; please sign in again'],
  404: ['Device not found'],
};

export async function isRevocationResponse(resp: Response): Promise<boolean> {
  const details = REVOCATION_DETAILS[resp.status];
  if (!details) return false;
  try {
    const body = (await resp.json()) as { detail?: unknown } | null;
    return typeof body?.detail === 'string' && details.includes(body.detail);
  } catch {
    return false;   // 不是 JSON（代理的錯誤頁）
  }
}

/**
 * 裝置心跳。只有 API 自己的撤銷回應（isRevocationResponse）才回 `revoked`；沒網路、逾時、5xx、其他 4xx 都是
 * `unreachable` —— 以前一律回 false、useAuth 就登出，沒網路時開 App 或伺服器短暫出錯都會被登出（對應 TofuTalk
 * 4518958）；之後任何 401/403/404 都算撤銷，出錯的部署也會把人登出（對應 TofuTalk 7c7251e）。
 * 逾時見 withRequestTimeout（iOS 15 沒有 AbortSignal.timeout），涵蓋讀錯誤回應的 body。
 */
export type PingResult = 'ok' | 'revoked' | 'unreachable';
export async function pingDevice(deviceId: string, jwt: string): Promise<PingResult> {
  try {
    return await withRequestTimeout<PingResult>(PING_TIMEOUT_MS, async (signal) => {
      const resp = await fetch(`${API_BASE}/devices/${encodeURIComponent(deviceId)}/ping`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}` },
        signal,
      });
      if (resp.ok) return 'ok';
      return (await isRevocationResponse(resp)) ? 'revoked' : 'unreachable';
    });
  } catch {
    return 'unreachable';
  }
}

/**
 * session 自己的效期（session.expiresAt 或 JWT 的 exp，本機時間）已過。JWT 的 exp 就是伺服器 session 的到期時間，
 * 沒有續期：過了之後每個端點都回 401 "Invalid or expired token"——跟部署出錯的 JWT secret 同一個回答，所以那個回答本身
 * 不能當撤銷（isRevocationResponse），要配上「本機效期也過了」才算到期（審查 HIGH-1）。只在請求失敗時問，時鐘偏快也不會
 * 讓還被接受的 session 登出。
 */
export function isSessionExpired(session: Pick<Session, 'jwt'> & Partial<Pick<Session, 'expiresAt'>>, nowMs = Date.now()): boolean {
  const now = Math.floor(nowMs / 1000);
  const jwtExp = parseJwtExp(session.jwt);
  return (typeof session.expiresAt === 'number' && session.expiresAt <= now) || (jwtExp !== null && jwtExp <= now);
}

/**
 * 開著的 App 的週期檢查：連續 `required` 次都是明確的「已撤銷」才登出；中間任何一次不是（成功、連不到）就重新計算
 * （對應 TofuTalk 7c7251e）。回傳 true = 現在該登出。
 */
export function revocationStreak(required = 2): (result: PingResult) => boolean {
  let streak = 0;
  return (result) => {
    streak = result === 'revoked' ? streak + 1 : 0;
    return streak >= required;
  };
}

// ===== Helpers =====

/**
 * 裝置 label — **只看硬體 / OS，不看瀏覽器**。
 *
 * 設計原則：使用者「認的是裝置」。同一台 PC 上 Edge / Chrome 應該顯示同一個 label
 * (例如 "Windows PC")，不該因為瀏覽器不同就分裂。手機 APK 跟 PWA 也都顯示
 * "Android Phone"（或具體型號 if Capacitor 給得出來）。
 */
function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) {
    // Capacitor WebView 帶實際 model；瀏覽器 Chrome 會 anonymize 成 Nexus 5
    const m = ua.match(/Android \d+(?:\.\d+)*;\s*([^;)]+?)\s*(?:Build|;|\))/);
    const model = m ? m[1].trim() : '';
    // 過濾 anonymized 預設值
    if (model && !/Nexus 5|K$/i.test(model)) return `${model} (Android)`;
    return 'Android Phone';
  }
  if (/Mac OS X/.test(ua)) return /Mobile/i.test(ua) ? 'Mac (touch)' : 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return '未知裝置';
}

function parseJwtExp(jwt: string): number | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(b64urlDecode(parts[1]));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function b64urlDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  return atob(s + '='.repeat(pad));
}
