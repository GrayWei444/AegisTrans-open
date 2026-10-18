/**
 * 這台裝置連哪一台 AegisTrans 伺服器（執行期選擇）。
 *
 * - 預設：官方服務（src/config/official-server.json，公開網址、不含任何密鑰）。自架者的 build 可以用
 *   VITE_DEFAULT_API_URL 等變數換掉預設值（見 packages/pwa/.env.example）—— 一旦設了 API 網址，預設值
 *   全部改讀這組變數，不會一半官方、一半自架。
 * - 使用者在「設定」或登入畫面改成自己的伺服器：只填 API 網址，其餘（MQTT broker、STUN/TURN、網頁網址、
 *   條款連結）由伺服器的 GET {api}/aegistrans/auth/server-config 提供。存在本機 localStorage（每個安裝各自一份）。
 * - 換伺服器 = 登出 + 重新載入（services/serverSwitch.ts），所以這裡的值在一次頁面生命週期內不會變，
 *   模組載入時讀一次即可。
 *
 * 這個檔案不能 import Capacitor 或 React：scripts/check-*.mjs 會在 Node 裡直接 bundle auth/useAuth/mqtt。
 */
import official from '../config/official-server.json';

export const SERVER_STORAGE_KEY = 'aegistrans_server';
/** 本機資料擁有者綁的伺服器（useAuth 換帳號判斷）；沒有這個 key 的舊安裝一律視為預設伺服器 */
export const DEFAULT_SERVER_KEY = 'default';
const DISCOVERY_PATH = '/aegistrans/auth/server-config';
const DISCOVERY_TIMEOUT_MS = 10_000;

export interface ServerLinks {
  privacy?: string;
  terms?: string;
  support?: string;
  deleteAccount?: string;
  supportEmail?: string;
  companyTerms?: string;
}

/** 使用者自選、存在本機的伺服器 */
export interface CustomServer {
  v: 1;
  apiUrl: string;
  mqttUrl: string;
  turnUrl?: string;
  stunUrls?: string[];
  webUrl?: string;
  name?: string;
  links?: ServerLinks;
}

export interface ActiveServer {
  isDefault: boolean;
  /** 本機資料歸屬用：'default' 或 'custom:<apiUrl>' */
  key: string;
  apiUrl: string;
  /** 只對預設伺服器的網頁版有效：網頁與 API 同源反向代理的路徑（官方為 /api） */
  webApiPath?: string;
  mqttUrl: string;
  turnUrl?: string;
  stunUrls?: string[];
  webUrl?: string;
  name?: string;
  links: ServerLinks;
}

type Env = Record<string, string | undefined>;

function buildEnv(): Env {
  try {
    return (import.meta.env as unknown as Env | undefined) ?? {};
  } catch {
    return {};
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

export type UrlKind = 'api' | 'mqtt' | 'web';
export type UrlCheck = { ok: true; url: string } | { ok: false; reason: 'invalid' | 'insecure' | 'credentials' | 'query' };

/**
 * 檢查並正規化網址：api／web 只收 https（localhost 開發可用 http），mqtt 只收 wss（localhost 可用 ws）。
 * 不收帳密、查詢字串或 #；去掉結尾斜線。
 */
export function normalizeServerUrl(raw: string, kind: UrlKind): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const secure = kind === 'mqtt' ? 'wss:' : 'https:';
  const plain = kind === 'mqtt' ? 'ws:' : 'http:';
  if (u.protocol !== secure && !(u.protocol === plain && isLocalHost(u.hostname))) {
    return { ok: false, reason: u.protocol === plain ? 'insecure' : 'invalid' };
  }
  if (!u.hostname) return { ok: false, reason: 'invalid' };
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  if (u.search || u.hash) return { ok: false, reason: 'query' };
  return { ok: true, url: stripTrailingSlash(`${u.protocol}//${u.host}${u.pathname}`) };
}

function isIceUrl(v: unknown): v is string {
  return typeof v === 'string' && /^(stun|turn|turns):[^\s/]+$/.test(v);
}

function cleanLinks(raw: unknown): ServerLinks {
  if (!raw || typeof raw !== 'object') return {};
  const out: ServerLinks = {};
  for (const k of ['privacy', 'terms', 'support', 'deleteAccount', 'companyTerms'] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string') {
      const c = normalizeServerUrl(v, 'web');
      if (c.ok) out[k] = c.url;
    }
  }
  const mail = (raw as Record<string, unknown>).supportEmail;
  if (typeof mail === 'string' && /^[^\s@]+@[^\s@]+$/.test(mail)) out.supportEmail = mail;
  return out;
}

function defaultServer(): ActiveServer {
  const e = buildEnv();
  if (e.VITE_DEFAULT_API_URL) {
    return {
      isDefault: true,
      key: DEFAULT_SERVER_KEY,
      apiUrl: stripTrailingSlash(e.VITE_DEFAULT_API_URL),
      webApiPath: e.VITE_DEFAULT_WEB_API_PATH || undefined,
      mqttUrl: e.VITE_DEFAULT_MQTT_URL ?? '',
      turnUrl: e.VITE_DEFAULT_TURN_URL || undefined,
      webUrl: e.VITE_DEFAULT_WEB_URL || undefined,
      name: e.VITE_DEFAULT_SERVER_NAME || undefined,
      links: cleanLinks({
        privacy: e.VITE_DEFAULT_PRIVACY_URL,
        terms: e.VITE_DEFAULT_TERMS_URL,
        support: e.VITE_DEFAULT_SUPPORT_URL,
      }),
    };
  }
  return {
    isDefault: true,
    key: DEFAULT_SERVER_KEY,
    apiUrl: official.apiUrl,
    webApiPath: official.webApiPath,
    mqttUrl: official.mqttUrl,
    turnUrl: official.turnUrl,
    webUrl: official.webUrl,
    name: official.name,
    links: { ...official.links },
  };
}

/** 驗證從 localStorage 或 server-config 來的資料；不合格回 null */
export function parseCustomServer(raw: unknown): CustomServer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.apiUrl !== 'string' || typeof r.mqttUrl !== 'string') return null;
  const api = normalizeServerUrl(r.apiUrl, 'api');
  const mqtt = normalizeServerUrl(r.mqttUrl, 'mqtt');
  if (!api.ok || !mqtt.ok) return null;
  const web = typeof r.webUrl === 'string' ? normalizeServerUrl(r.webUrl, 'web') : null;
  const stun = Array.isArray(r.stunUrls) ? r.stunUrls.filter(isIceUrl) : undefined;
  return {
    v: 1,
    apiUrl: api.url,
    mqttUrl: mqtt.url,
    turnUrl: isIceUrl(r.turnUrl) ? r.turnUrl : undefined,
    stunUrls: stun && stun.length ? stun : undefined,
    webUrl: web && web.ok ? web.url : undefined,
    name: typeof r.name === 'string' ? r.name.slice(0, 60) : undefined,
    links: cleanLinks(r.links),
  };
}

export function readCustomServer(): CustomServer | null {
  try {
    const raw = localStorage.getItem(SERVER_STORAGE_KEY);
    return raw ? parseCustomServer(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** 顯示用：網址的 host（例如給使用者在新裝置打開的網頁）；沒有或格式不對回 null */
export function webHost(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export function customServerKey(apiUrl: string): string {
  return `custom:${apiUrl}`;
}

let cached: ActiveServer | null = null;

/** 目前使用的伺服器（一次頁面生命週期內固定；換伺服器會重新載入） */
export function getActiveServer(): ActiveServer {
  if (cached) return cached;
  const custom = readCustomServer();
  cached = custom
    ? {
        isDefault: false,
        key: customServerKey(custom.apiUrl),
        apiUrl: custom.apiUrl,
        mqttUrl: custom.mqttUrl,
        turnUrl: custom.turnUrl,
        stunUrls: custom.stunUrls,
        webUrl: custom.webUrl,
        name: custom.name,
        links: custom.links ?? {},
      }
    : defaultServer();
  return cached;
}

/** 預設伺服器（給設定畫面顯示「官方伺服器」是哪一台） */
export function getDefaultServer(): ActiveServer {
  return defaultServer();
}

/** 存使用者自選的伺服器；寫不進去（私密模式／空間滿）會 throw，由呼叫端回報 */
export function saveCustomServer(server: CustomServer): void {
  localStorage.setItem(SERVER_STORAGE_KEY, JSON.stringify(server));
}

export function clearCustomServer(): void {
  localStorage.removeItem(SERVER_STORAGE_KEY);
}

export type DiscoveryResult =
  | { ok: true; server: CustomServer }
  | { ok: false; reason: 'invalid_url' | 'insecure_url' | 'unreachable' | 'not_aegistrans' | 'bad_config' };

/**
 * 問伺服器要它的連線設定：GET {apiUrl}/aegistrans/auth/server-config。
 * 回應格式見 api/README.md；mqtt_url 必填，其餘選填。
 */
export async function discoverServer(rawApiUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveryResult> {
  const api = normalizeServerUrl(rawApiUrl, 'api');
  if (!api.ok) return { ok: false, reason: api.reason === 'insecure' ? 'insecure_url' : 'invalid_url' };
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS) : null;
  let body: unknown;
  try {
    const resp = await fetchImpl(`${api.url}${DISCOVERY_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: ctrl?.signal,
    });
    if (!resp.ok) return { ok: false, reason: resp.status === 404 ? 'not_aegistrans' : 'bad_config' };
    body = await resp.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).service !== 'aegistrans') {
    return { ok: false, reason: 'not_aegistrans' };
  }
  const b = body as Record<string, unknown>;
  const server = parseCustomServer({
    apiUrl: api.url,
    mqttUrl: b.mqtt_url,
    turnUrl: b.turn_url,
    stunUrls: b.stun_urls,
    webUrl: b.web_url,
    name: b.name,
    links: b.links,
  });
  return server ? { ok: true, server } : { ok: false, reason: 'bad_config' };
}
