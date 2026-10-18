/**
 * Phase 1 收尾：Device ID 從 hardware fingerprint 派生（取代 random UUID v4）
 *
 * 用於 MQTT clientId 區分多設備連線。
 *
 * **為什麼從 random UUID 改成 fingerprint-derived**：
 * 同一台實體電腦上開 Chrome + Firefox + 無痕視窗，原本各自 localStorage
 * 隨機產 UUID → 各自獨立 MQTT clientId → EMQX 不會踢舊 session → 一台機
 * 變成 N 個 P2P group 成員 → 廣播扇出爆掉。
 *
 * Fingerprint-derived 之後：
 *   - 同硬體（不同瀏覽器）→ 同 deviceId → 同 MQTT clientId → EMQX 自動踢舊
 *   - 不同硬體 → 不同 deviceId → 多裝置正常並存（by design）
 *
 * 跟 backend 的 `WHERE user_id=? AND pubkey=?` dedupe 邏輯對齊
 * （backend 同 fingerprint→同 pubkey→同 device row）。
 *
 * 儲存策略：localStorage (sync cache) + SQLite (durable)
 */

import * as db from './database';
import { computeMachineFingerprint } from './fingerprint';
import { devLog } from '../utils/devLog';

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEY = 'aegis_device_id';

// 舊版 UUID v4 格式：8-4-4-4-12 hex with hyphens（要 migration）
const LEGACY_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isLegacyUUID(s: string): boolean {
  return LEGACY_UUID_REGEX.test(s);
}

/**
 * 從 fingerprint 派生 deterministic device ID（前 16 hex = 64 bits，足夠當 clientId 後綴）
 */
async function deriveDeviceIdFromFingerprint(): Promise<string> {
  const fp = await computeMachineFingerprint();
  return fp.slice(0, 16);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 取得或建立裝置 ID（fingerprint-derived，deterministic）
 *
 * 首次呼叫：computeMachineFingerprint → 取前 16 hex → 寫進 localStorage
 * 後續：從 localStorage 直接回傳
 * 舊版 UUID v4 格式自動遷移成 fingerprint-derived
 */
export async function getDeviceId(): Promise<string> {
  // Try localStorage first
  let deviceId = localStorage.getItem(STORAGE_KEY);

  // Migration: 舊版 random UUID 換成 fingerprint-derived
  if (deviceId && isLegacyUUID(deviceId)) {
    devLog('[DeviceId] Legacy UUID detected, migrating to fingerprint-derived');
    deviceId = null;
  }

  if (deviceId) return deviceId;

  // Fallback to SQLite（同樣檢查 legacy）
  try {
    const fromDb = (await db.getSetting(STORAGE_KEY)) ?? null;
    if (fromDb && !isLegacyUUID(fromDb)) {
      localStorage.setItem(STORAGE_KEY, fromDb);
      return fromDb;
    }
  } catch {
    // SQLite not ready yet
  }

  // Compute from fingerprint
  deviceId = await deriveDeviceIdFromFingerprint();
  localStorage.setItem(STORAGE_KEY, deviceId);
  db.setSetting(STORAGE_KEY, deviceId).catch(() => {});
  devLog('[DeviceId] Derived from fingerprint:', deviceId);
  return deviceId;
}

/**
 * 同步取得裝置 ID（僅從 localStorage，可能為 null）
 *
 * 用於需要同步存取的場景（如 MQTT clientId 建構）
 */
export function getDeviceIdSync(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

/**
 * 確保裝置 ID 已初始化（app 啟動時呼叫）
 */
export async function ensureDeviceId(): Promise<string> {
  return getDeviceId();
}
