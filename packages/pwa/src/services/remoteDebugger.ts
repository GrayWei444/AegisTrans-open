/**
 * Remote Debug Logger — MQTT 遠端除錯系統（只給 dogfood build 用）
 *
 * 透過 MQTT 把 console log 即時串流到除錯用的 broker。iOS 和 Android 共用同一份代碼（Web 層）。
 *
 * 只有同時滿足才會動：
 *   - build 時 VITE_DEBUG_TOOLS=1（release build 整段被 tree-shake，見 utils/debugFlags.ts）
 *   - build 時設了 VITE_REMOTE_DEBUG_MQTT_URL 與 VITE_REMOTE_DEBUG_TOKEN_URL
 * 公開版預設兩個端點都沒有 → enable() 直接返回，不攔 console、不連任何地方。
 *
 * 啟用方式（上面條件成立時）：
 * 1. URL param: ?debug=1
 * 2. localStorage: aegis_remote_debug = "1"
 * 3. 程式碼: remoteDebugger.enable()
 *
 * MQTT Topic: aegis/debug/{platform}/{deviceId}
 */

import mqtt, { MqttClient } from 'mqtt';
import { getDeviceIdSync } from './deviceId';

const ENV = import.meta.env as unknown as Record<string, string | undefined>;
const MQTT_BROKER = ENV.VITE_REMOTE_DEBUG_MQTT_URL ?? '';
/** 換除錯 token 的完整網址 */
const TOKEN_URL = ENV.VITE_REMOTE_DEBUG_TOKEN_URL ?? '';
/** 網頁版若跑在與 token 端點同一個網域底下，改用同源路徑（避開 CORS）；兩個都要設才生效 */
const SAME_ORIGIN_TOKEN_PATH = ENV.VITE_REMOTE_DEBUG_SAME_ORIGIN_TOKEN_PATH ?? '';
const SAME_ORIGIN_MATCH = ENV.VITE_REMOTE_DEBUG_SAME_ORIGIN_MATCH ?? '';
const MAX_BUFFER = 500;
const STORAGE_KEY = 'aegis_remote_debug';

/** 這個 build 有沒有設定除錯端點 */
export const REMOTE_DEBUG_CONFIGURED = MQTT_BROKER !== '' && TOKEN_URL !== '';

interface DebugLogEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message: string;
  timestamp: string;
  platform: string;
  deviceId: string;
  source: 'webview' | 'native';
  deviceLabel?: string;
  meta?: Record<string, unknown>;
}

class RemoteDebugger {
  private client: MqttClient | null = null;
  private enabled = false;
  private buffer: DebugLogEntry[] = [];
  private platform: string = 'unknown';
  private deviceId: string = 'unknown';
  private deviceLabel: string | undefined;
  private topic: string = '';

  private originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  shouldEnable(): boolean {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('debug') === '1') return true;
    } catch { /* not in browser */ }
    try {
      if (localStorage.getItem(STORAGE_KEY) === '1') return true;
    } catch { /* localStorage not available */ }
    return false;
  }

  async enable(label?: string): Promise<void> {
    if (this.enabled || !REMOTE_DEBUG_CONFIGURED) return;
    this.enabled = true;
    this.deviceLabel = label;
    this.platform = this.detectPlatform();
    this.deviceId = getDeviceIdSync() || `anon-${Date.now()}`;
    this.topic = `aegis/debug/${this.platform}/${this.deviceId.slice(0, 8)}`;
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
    this.interceptConsole();
    await this.connectMqtt();
    this.send('info', `[RemoteDebug] Enabled - platform=${this.platform}, device=${this.deviceId.slice(0, 8)}, label=${label || 'none'}`);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    this.restoreConsole();
    if (this.client) {
      try { this.client.end(true); } catch { /* ignore */ }
      this.client = null;
    }
    this.buffer = [];
  }

  send(level: DebugLogEntry['level'], message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const entry: DebugLogEntry = {
      level, message,
      timestamp: new Date().toISOString(),
      platform: this.platform,
      deviceId: this.deviceId.slice(0, 8),
      source: 'webview',
      deviceLabel: this.deviceLabel,
      meta,
    };
    this.publishOrBuffer(entry);
  }

  sendNative(level: DebugLogEntry['level'], message: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const entry: DebugLogEntry = {
      level, message,
      timestamp: new Date().toISOString(),
      platform: this.platform,
      deviceId: this.deviceId.slice(0, 8),
      source: 'native',
      deviceLabel: this.deviceLabel,
      meta,
    };
    this.publishOrBuffer(entry);
  }

  isEnabled(): boolean { return this.enabled; }

  // --- Private ---

  private detectPlatform(): string {
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    if (/macintosh|mac os/.test(ua)) return 'macos';
    if (/windows/.test(ua)) return 'windows';
    return 'web';
  }

  private async fetchDebugToken(): Promise<string | null> {
    try {
      const debugId = `debug_${this.deviceId.slice(0, 8)}`;
      const encoder = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(debugId));
      const hashArr = new Uint8Array(hashBuf);
      const pubkeyHash = Array.from(hashArr).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
      // 網頁版跑在除錯 API 同一網域底下時用同源路徑，避免跨域問題
      const sameOrigin = SAME_ORIGIN_TOKEN_PATH !== '' && SAME_ORIGIN_MATCH !== ''
        && typeof window !== 'undefined' && window.location.origin.includes(SAME_ORIGIN_MATCH);
      const tokenUrl = sameOrigin ? SAME_ORIGIN_TOKEN_PATH : TOKEN_URL;
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkeyHash }),
      });
      if (!response.ok) return null;
      const data = await response.json() as { token: string };
      return data.token;
    } catch { return null; }
  }

  private async connectMqtt(): Promise<void> {
    try {
      // Token 必須成功取得，否則 EMQX JWT 認證會拒絕連線
      let token = await this.fetchDebugToken();
      if (!token) {
        // Retry once after 2s（首次可能因網路尚未就緒而失敗）
        await new Promise(r => setTimeout(r, 2000));
        token = await this.fetchDebugToken();
      }
      if (!token) {
        this.originalConsole.error('[RemoteDebug] Failed to fetch MQTT token — debug disabled');
        this.enabled = false;
        return;
      }
      this.client = mqtt.connect(MQTT_BROKER, {
        clientId: `debug_${this.deviceId.slice(0, 8)}_${Date.now() % 100000}`,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        keepalive: 30,
        username: `debug_${this.deviceId.slice(0, 8)}`,
        password: token,
      });
      this.client.on('connect', () => {
        this.originalConsole.log('[RemoteDebug] MQTT connected, flushing buffer...');
        this.flushBuffer();
      });
      this.client.on('error', (err) => {
        this.originalConsole.warn('[RemoteDebug] MQTT error:', err.message);
      });
      this.client.on('close', () => {
        this.originalConsole.warn('[RemoteDebug] MQTT disconnected');
      });
    } catch (err) {
      this.originalConsole.error('[RemoteDebug] Failed to connect MQTT:', err);
    }
  }

  private publishOrBuffer(entry: DebugLogEntry): void {
    if (this.client?.connected) {
      this.client.publish(this.topic, JSON.stringify(entry), { qos: 0 });
    } else {
      if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
      this.buffer.push(entry);
    }
  }

  private flushBuffer(): void {
    if (!this.client?.connected || this.buffer.length === 0) return;
    const count = this.buffer.length;
    const entries = [...this.buffer];
    this.buffer = [];
    for (const entry of entries) {
      this.client.publish(this.topic, JSON.stringify(entry), { qos: 0 });
    }
    this.originalConsole.log(`[RemoteDebug] Flushed ${count} buffered logs`);
  }

  private interceptConsole(): void {
    const self = this;
    const levels: Array<'log' | 'warn' | 'error' | 'info' | 'debug'> = ['log', 'warn', 'error', 'info', 'debug'];
    for (const level of levels) {
      const original = self.originalConsole[level];
      console[level] = (...args: unknown[]) => {
        original(...args);
        const msg = args.map(a => {
          if (typeof a === 'string') return a;
          // DOMException / Error 的屬性是 non-enumerable，JSON.stringify 會輸出 {}
          if (a instanceof Error || a instanceof DOMException) {
            return `${a.constructor.name}: ${a.message}` + (a.stack ? ` | stack: ${a.stack.slice(0, 200)}` : '');
          }
          try {
            const json = JSON.stringify(a);
            return json === '{}' ? String(a) : json;
          } catch { return String(a); }
        }).join(' ');
        if (msg.startsWith('[RemoteDebug]')) return;
        self.send(level, msg);
      };
    }
  }

  private restoreConsole(): void {
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    console.info = this.originalConsole.info;
    console.debug = this.originalConsole.debug;
  }
}

export const remoteDebugger = new RemoteDebugger();

export async function initRemoteDebugger(): Promise<void> {
  if (remoteDebugger.shouldEnable()) {
    await remoteDebugger.enable();
  }
}

export default remoteDebugger;
