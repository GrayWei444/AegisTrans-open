/**
 * accountWipe — 切換帳號時清空本機資料（CR-02：wipe-on-switch 隔離模型）
 *
 * AegisTrans 是「自己對自己」的個人工具，且產品設計第 3 條明示「訊息歷史不保證
 * 永久」。所以帳號隔離採 wipe-on-switch：**同一台瀏覽器上換成「另一個帳號」登入時，
 * 把前一個帳號殘留在本機的所有資料清掉**（訊息 / 檔案 / 身分 / ratchet / 金鑰），
 * 避免帳號 B 繼承到帳號 A 的本機資料（共用瀏覽器的隱私漏洞）。
 *
 * 同帳號登出再登入「不會」清（保留歷史）；只有「換帳號」才清。偵測點在 useAuth 的
 * 登入流程（用 aegistrans_last_email 標記比對 email），清完一律 reload 讓 React tree
 * 與 useCrypto in-memory 狀態（identity / sessions ref / encKey）從零開始。
 *
 * ponytail: 清的是 per-account 的 key/table；UI 偏好（theme/language）、裝置安裝 id、
 * debug flag、目前 session 一律保留 —— 換帳號的新 session 由呼叫端管理。
 */

import * as db from './database';
import { clearEncryptionKey } from './keyEncryption';
import { clearAllBlobs, hasAnyBlob } from './messageStore';
import { getNativeFileStream } from './nativeFileStream';
import { DEBUG_TOOLS } from '../utils/debugFlags';
import { SEED_KEY_PREFIX } from './accountDevices';

// e2e only：注入一次 wipe 失敗，驗證 fail-closed 真的擋住切換。release build 永遠 false。
let _failNextWipe = false;
if (DEBUG_TOOLS && typeof window !== 'undefined') {
  // @ts-expect-error debug seam
  window.__aegisDebug = window.__aegisDebug || {};
  // @ts-expect-error debug seam
  window.__aegisDebug.accountWipe = { failNext: () => { _failNextWipe = true; } };
}

// localStorage：屬於「帳號」的 key（清）。
// 不清：aegistrans_session（目前登入的 session，呼叫端管）、aegistrans_last_email（本模組標記）、
//      aegistrans_language / aegistrans_theme（UI 偏好）、aegis_device_id（裝置安裝 id，跨帳號共用）、
//      AEGIS_* debug flag。
const PER_ACCOUNT_LS = [
  'aegistrans_keys',
  'aegistrans_sessions',
  'aegistrans_session_version',
  'aegistrans_wasm_core_version',
  'aegis_key_salt',
  'aegistrans_identity_pub_b64',
  'aegistrans_prekey_store',
  'aegistrans_p2p_outbox',
  'aegistrans_x3dh_accepted_v1',     // 已接受的 X3DH_INIT（x3dhReplay，含同帳號裝置 pubkey）
  'aegistrans_device_id',            // 換帳號 → 強制重新註冊裝置（不可帶舊帳號 device id）
  'aegistrans_pending_request_id',
  'aegistrans_pending_email',
  // legacy AegisTalk fork 殘留
  'mist_keys', 'mist_sessions', 'mist_session_version', 'mist_wasm_core_version', 'mist_pin_hash',
];

const PER_ACCOUNT_SS = ['aegis_eph_key', 'aegis_ek_active'];

// SQLite settings 表裡的 per-account key（清）
const PER_ACCOUNT_SETTINGS = [
  'aegistrans_keys', 'aegistrans_sessions', 'aegistrans_session_version',
  'aegistrans_wasm_core_version', 'aegis_key_salt', 'aegistrans_prekey_store',
  'mist_keys', 'mist_sessions', 'mist_pin_hash',
];

// SQLite per-account 資料表（整表清空；非帳號相關的 settings/blacklist 等不動）
const PER_ACCOUNT_TABLES = ['messages', 'conversations', 'group_keys', 'pending_messages', 'ratchet_states'];


/**
 * 清空本機「帳號層級」資料。換帳號登入時呼叫；呼叫端負責後續 reload。
 *
 * **Fail-closed（CR-02 商用化修正）**：所有帳號共用同一顆本機 DB，若清除失敗卻仍讓新帳號
 * 登入，帳號 B 會看到帳號 A 殘留的訊息/檔案（共用瀏覽器的隱私洩漏）。因此改為：任一步「持有
 * 帳號內容」的清除失敗 → 累積後 throw，呼叫端必須中止切換並報錯，不得繼續登入新帳號。
 *
 * 「內容」步驟（失敗即擋）：encKey IDB 刪除、SQLite per-account 表、檔案 blob。
 * localStorage/sessionStorage 的金鑰本身已加密 at-rest，且移除幾乎不會失敗，仍一併記入。
 */
/**
 * 偵測本機是否還有「帳號層級」資料痕跡 —— 給 useAuth 在 owner marker 缺失時判斷是否要 fail-closed
 * wipe（review 2026-07-17：訊息在共用 SQLite、blob 在 IndexedDB，只看 localStorage.aegistrans_keys
 * 會漏；localStorage 被部分清但 SQLite/blob 還在時，換帳號會誤判成新裝置而不 wipe → B 讀到 A 的資料）。
 *
 * 檢查多訊號：localStorage 身分/金鑰 key、IndexedDB 檔案 blob store、SQLite per-account 表。
 * SQLite 開不起來時**不採計**該訊號（避免冷啟動 jeep-sqlite flake 誤判 → 誤 wipe 造成資料遺失）；
 * 其他訊號已足以在「有殘留」時回 true。
 */
export async function hasLocalAccountData(): Promise<'has' | 'empty' | 'unknown'> {
  // review #3 三態:不可把「檢查失敗」當成「沒有資料」。DB 冷啟動開不起來 / blob 讀失敗 = **unknown**,
  // 呼叫端須 fail-closed（當換帳號、wipe/中止登入）,不能當 empty 放行 → 否則 localStorage/blob 已清但
  // SQLite 還留 A 訊息、DB 又暫時開不起來時,會誤判「無資料」→ B 不 wipe → DB 復原後 B 讀到 A 的訊息。
  let uncertain = false;
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    for (const k of ['aegistrans_keys', 'aegistrans_sessions', 'aegistrans_identity_pub_b64',
                     'aegistrans_prekey_store', 'mist_keys', 'mist_sessions']) {
      if (localStorage.getItem(k)) return 'has';
    }
  } catch { uncertain = true; } // localStorage 讀不到 = 不確定,不能當 empty
  try { if (await hasAnyBlob()) return 'has'; } catch { uncertain = true; }
  try {
    await db.initDatabase();
    for (const t of ['messages', 'group_keys', 'ratchet_states']) {
      try {
        const r = await db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${t}`);
        if (r && r[0] && Number(r[0].cnt) > 0) return 'has';
      } catch (e) {
        // "no such table" = 該表本來就沒有 = 此訊號確定 empty（不增不確定性）;
        // 其他 query error（DB 鎖住/損毀）= 可能有資料只是讀不到 = 不確定。
        if (!/no such table/i.test(msg(e))) uncertain = true;
      }
    }
  } catch { uncertain = true; } // DB 開不起來 → 無法確認 SQLite 有無資料 = 不確定
  return uncertain ? 'unknown' : 'empty';
}

export async function wipeLocalAccountData(): Promise<void> {
  const failures: string[] = [];
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  if (_failNextWipe) {
    _failNextWipe = false;
    throw new Error('wipeLocalAccountData 未完全清除，禁止切換帳號（避免跨帳號資料殘留）: injected-test-failure');
  }

  // 1. in-memory 加密金鑰 + 其 IDB 快取 + sessionStorage marker（await：IDB 刪除要真的完成）
  try { await clearEncryptionKey(); } catch (e) { failures.push('encKey:' + msg(e)); }

  // 2. localStorage / sessionStorage
  for (const k of PER_ACCOUNT_LS) { try { localStorage.removeItem(k); } catch (e) { failures.push('ls:' + k + ':' + msg(e)); } }
  for (const k of PER_ACCOUNT_SS) { try { sessionStorage.removeItem(k); } catch (e) { failures.push('ss:' + k + ':' + msg(e)); } }
  // 上一份成功的裝置清單（accountDevices，含該帳號所有裝置公鑰），key 帶 userId → 依前綴清
  try {
    const seeds = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .filter((k): k is string => !!k && k.startsWith(SEED_KEY_PREFIX));
    for (const k of seeds) localStorage.removeItem(k);
  } catch (e) { failures.push('ls:' + SEED_KEY_PREFIX + '*:' + msg(e)); }

  // 3. SQLite：per-account 表 + settings key（共用同一顆 DB，只清表，不 drop DB —— 避免冷啟動空覆寫地雷）
  try {
    await db.initDatabase();
    for (const t of PER_ACCOUNT_TABLES) {
      try {
        await db.clearTable(t);
      } catch (e) {
        // initDatabase 後這些表必然存在；"no such table" 代表本來就沒該類資料 → 不算殘留、不算失敗。
        // 其他錯（DB 鎖住/損毀）= 內容可能還在 → 記為失敗，擋住切換。
        if (!/no such table/i.test(msg(e))) failures.push('table:' + t + ':' + msg(e));
      }
    }
    for (const k of PER_ACCOUNT_SETTINGS) { try { await db.deleteSetting(k); } catch (e) { failures.push('setting:' + k + ':' + msg(e)); } }
  } catch (e) {
    // DB 開不起來 → 無法保證 per-account 表已清 → fail-closed。
    failures.push('db-init:' + msg(e));
  }

  // 4. IndexedDB 檔案 blob：清空 object store（可 await，不被開啟連線卡住 —— 見 clearAllBlobs）。
  //    encKey 的 IDB 快取(aegis_ek_session) + sessionStorage marker 已由上面 clearEncryptionKey() 處理。
  try { await clearAllBlobs(); } catch (e) { failures.push('blobs:' + msg(e)); }

  // 5. native fs 大檔目錄（>2GB stream-to-disk，Electron / iOS / Android）——跨帳號不可殘留大檔。
  try {
    const r = await getNativeFileStream()?.wipeAll();
    if (r && !r.ok) failures.push('fsfiles:' + (r.error ?? 'unknown'));
  } catch (e) { failures.push('fsfiles:' + msg(e)); }

  if (failures.length) {
    throw new Error('wipeLocalAccountData 未完全清除，禁止切換帳號（避免跨帳號資料殘留）: ' + failures.join(' | '));
  }
}
