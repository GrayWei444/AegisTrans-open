/**
 * AegisTrans Identity Service — 公鑰快取 + mqtt gate
 *
 * ⚠️ 2026-06 變更:身分私鑰改為**隨機生成**(useCrypto.generateIdentity → Identity.generate()),
 * **不再用 email + fingerprint 派生**(舊做法低熵、可暴力破解)。fingerprint 只留作裝置去重。
 *
 * 本檔退化成「公鑰字串快取」:useCrypto 生成/解鎖隨機 identity 後呼叫 setLocalIdentity(),
 * 把公鑰存 localStorage 給非 React 的同步路徑(mqtt.ts gate / SettingsPage 顯示)用。
 */

const PUB_KEY_CACHE_KEY = 'aegistrans_identity_pub_b64';

/**
 * useCrypto 生成或解鎖隨機 identity 後呼叫:
 *   1. 快取公鑰(base64)供 getPublicKeyBase64Sync 同步取用
 *   2. 開 mqtt.ts 的 gate 旗標(AegisTalk 用 mist_pin_hash 判 PIN setup;
 *      AegisTrans 沒 PIN,設個 marker 讓 mqtt token fetch 不被 gate 擋住)
 */
export function setLocalIdentity(publicKeyBase64: string): void {
  try {
    localStorage.setItem(PUB_KEY_CACHE_KEY, publicKeyBase64);
  } catch { /* ignore quota */ }
  if (!localStorage.getItem('mist_pin_hash')) {
    try { localStorage.setItem('mist_pin_hash', 'aegistrans'); } catch { /* ignore */ }
  }
}

/**
 * 同步取得本裝置公鑰(base64);useCrypto 生成/解鎖 identity 後才有值。
 */
export function getPublicKeyBase64Sync(): string | null {
  return localStorage.getItem(PUB_KEY_CACHE_KEY);
}

/**
 * 清空本機 identity 公鑰快取(登出時呼叫)。
 */
export function clearIdentity(): void {
  try {
    localStorage.removeItem(PUB_KEY_CACHE_KEY);
  } catch { /* ignore */ }
}
