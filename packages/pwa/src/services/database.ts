import { devLog } from '../utils/devLog';

/**
 * Unified Database Service — 統一 SQLite 資料庫
 *
 * 透過 @capacitor-community/sqlite 實現跨平台 SQLite：
 * - Android/iOS：原生 SQLite（.db 檔案）
 * - Web (PWA)：sql.js + IndexedDB（plugin 自動處理）
 *
 * 所有持久化資料都走這個 service，不再直接使用 localStorage 或 IndexedDB。
 */

import { CapacitorSQLite as CapacitorSQLiteProxy } from '@capacitor-community/sqlite';
import { CapacitorSQLiteWeb } from '@capacitor-community/sqlite/dist/esm/web';
import { Capacitor } from '@capacitor/core';
import { isNativeApp } from './capacitor';

// Capacitor 8 在 platform==='electron' 時不會自動 fall back 到 web 變體 — 直接
// 拋 "plugin not implemented on electron"。而我們刻意不在 electron-plugins.js 註冊
// CapacitorSQLite native impl(避開 better-sqlite3-multiple-ciphers native build 撞
// Python 3.13 distutils 移除)。
//
// 解法:在 Electron 平台強制用 web 變體 class(jeep-sqlite + IndexedDB),其他平台
// 維持原來 proxy(PWA 走 web,iOS/Android 走 native)。
const CapacitorSQLite = Capacitor.getPlatform() === 'electron'
  ? (new CapacitorSQLiteWeb() as unknown as typeof CapacitorSQLiteProxy)
  : CapacitorSQLiteProxy;

// 資料庫名稱
const DB_NAME = 'aegistalk';

// 連線狀態
let initialized = false;
let initPromise: Promise<void> | null = null;
let isWeb = false;

// ============================================
// Schema 版本遷移系統
// ============================================

/**
 * 目前 schema 版本。每次新增/修改表格時遞增此值，
 * 並在 MIGRATIONS 陣列中加入對應的遷移 SQL。
 */
const SCHEMA_VERSION = 8;

/**
 * 增量遷移紀錄：從 version N → N+1 的 SQL
 * 每個 entry 的 version 代表「遷移到此版本」所需的 SQL。
 * 初始 schema (version 1) 由 SCHEMA_SQL 處理，不需要 migration entry。
 *
 * 範例：未來新增 payment_records 表
 * { version: 2, sql: 'CREATE TABLE IF NOT EXISTS payment_records (...)' }
 */
interface Migration {
  version: number;
  sql: string;
  description: string;
  /** Individual ALTER TABLE statements — each runs in its own try-catch (tolerates "duplicate column") */
  individualStatements?: string[];
  /**
   * 標記為核心 migration（建立 core flow 依賴的表）。失敗時 re-throw → 走 init error 路徑，
   * 不要靜默 break 後以半套 schema 啟動（下游 query 會在離成因很遠處炸）。非核心（如 fork
   * 死表 ALTER）維持原本「記錄 breadcrumb + break、不阻擋啟動」行為。
   */
  critical?: boolean;
}

const MIGRATIONS: Migration[] = [
  // version 1: 初始 schema，由 SCHEMA_SQL 建立，不需要 migration entry
  {
    version: 2,
    sql: [
      // user_blacklist: 新增 note、block_count 欄位
      'ALTER TABLE user_blacklist ADD COLUMN note TEXT DEFAULT \'\'',
      'ALTER TABLE user_blacklist ADD COLUMN block_count INTEGER DEFAULT 1',
      // user_whitelist: 新增 note 欄位
      'ALTER TABLE user_whitelist ADD COLUMN note TEXT DEFAULT \'\'',
      // local_user_blacklist: 新增 pubkey、notes、nickname 欄位
      'ALTER TABLE local_user_blacklist ADD COLUMN pubkey TEXT DEFAULT \'\'',
      'ALTER TABLE local_user_blacklist ADD COLUMN notes TEXT',
      'ALTER TABLE local_user_blacklist ADD COLUMN nickname TEXT',
      // guardian_alerts: 新增 protected_pubkey、protected_nickname、status、handled_at
      'ALTER TABLE guardian_alerts ADD COLUMN protected_pubkey TEXT DEFAULT \'\'',
      'ALTER TABLE guardian_alerts ADD COLUMN protected_nickname TEXT DEFAULT \'\'',
      'ALTER TABLE guardian_alerts ADD COLUMN status TEXT DEFAULT \'pending\'',
      'ALTER TABLE guardian_alerts ADD COLUMN handled_at INTEGER',
      // checkin_records: 新增 requested_at、responded_at、response_type
      'ALTER TABLE checkin_records ADD COLUMN requested_at INTEGER',
      'ALTER TABLE checkin_records ADD COLUMN responded_at INTEGER',
      'ALTER TABLE checkin_records ADD COLUMN response_type TEXT',
      // download_history: 新增 status、data_url、source_id、started_at、completed_at
      'ALTER TABLE download_history ADD COLUMN status TEXT DEFAULT \'completed\'',
      'ALTER TABLE download_history ADD COLUMN data_url TEXT',
      'ALTER TABLE download_history ADD COLUMN source_id TEXT',
      'ALTER TABLE download_history ADD COLUMN started_at INTEGER',
      'ALTER TABLE download_history ADD COLUMN completed_at INTEGER',
    ].join(';\n') + ';',
    description: 'Phase 3: Additional columns for localStorage migration',
  },
  {
    version: 3,
    sql: '',  // Handled individually below (ALTER TABLE may fail with "duplicate column")
    description: 'Phase 19: Guardian group group_type + guardian_settings',
    individualStatements: [
      'ALTER TABLE groups ADD COLUMN group_type TEXT',
      'ALTER TABLE groups ADD COLUMN guardian_settings TEXT',
    ],
  },
  {
    version: 4,
    sql: '',
    description: 'Fix ConversationId collision: use full pubkey instead of slice(0,16)',
    individualStatements: [
      // 更新 messages 的 conversation_id（使用 conversations.peer_pubkey 計算新 id）
      `UPDATE messages SET conversation_id = 'conv-' || (
        SELECT c.peer_pubkey FROM conversations c WHERE c.id = messages.conversation_id
      ) WHERE conversation_id LIKE 'conv-%' AND LENGTH(conversation_id) < 60`,
      // 更新 conversations 的 id
      `UPDATE conversations SET id = 'conv-' || peer_pubkey WHERE id LIKE 'conv-%' AND LENGTH(id) < 60`,
    ],
  },
  {
    version: 5,
    sql: '',
    description: 'ADR-016: Group Key table for shared group encryption',
    critical: true,  // group_keys 是 AegisTrans E2EE 核心表，失敗不可靜默吞
    individualStatements: [
      `CREATE TABLE IF NOT EXISTS group_keys (
        group_id TEXT NOT NULL,
        key_id TEXT NOT NULL PRIMARY KEY,
        key_base64 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        expires_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_group_keys_group_id ON group_keys(group_id)`,
      `CREATE INDEX IF NOT EXISTS idx_group_keys_active ON group_keys(group_id, is_active)`,
    ],
  },
  {
    version: 6,
    sql: '',
    description: 'Group keys: rotation flag + distributing device (active set derived, not by arrival order)',
    critical: true,  // groupKey.ts 讀寫這兩欄；缺欄位時收不了金鑰
    individualStatements: [
      // 既有資料列：不是輪換、沒有交來的裝置（NULL＝舊資料列，照舊處理）
      'ALTER TABLE group_keys ADD COLUMN is_rotation INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE group_keys ADD COLUMN distributor TEXT',
    ],
  },
  {
    version: 7,
    sql: '',
    description: 'Group keys: local storage order (a key only outlives a rotation if it was stored after it)',
    critical: true,  // groupKey.ts 寫入與重算都用 stored_seq
    individualStatements: [
      'ALTER TABLE group_keys ADD COLUMN stored_seq INTEGER',
      // 既有資料列照插入順序編號（rowid；handleKeyDistribution 不覆蓋既有 keyId，is_active 是 UPDATE，不會改 rowid）
      'UPDATE group_keys SET stored_seq = rowid WHERE stored_seq IS NULL',
    ],
  },
  {
    version: 8,
    sql: '',
    description: 'Group keys: keys received in answer to a key request are for decryption only',
    critical: true,  // groupKey.ts 寫入與重算都用 decrypt_only
    individualStatements: [
      'ALTER TABLE group_keys ADD COLUMN decrypt_only INTEGER NOT NULL DEFAULT 0',
    ],
  },
];

/** 所有 CREATE TABLE 語句 */
const SCHEMA_SQL = `
-- 聯絡人
CREATE TABLE IF NOT EXISTS contacts (
  pubkey TEXT PRIMARY KEY,
  nickname TEXT,
  avatar TEXT,
  added_at INTEGER NOT NULL,
  trust_level TEXT DEFAULT 'unverified',
  push_subscription TEXT,
  bypass_fraud_detection INTEGER DEFAULT 0
);

-- 對話
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  peer_pubkey TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'direct',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 訊息
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,
  content TEXT NOT NULL,
  msg_type TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  ttl INTEGER DEFAULT 0,
  expires_at INTEGER,
  read_at INTEGER,
  is_outgoing INTEGER DEFAULT 0,
  status TEXT DEFAULT 'sent',
  group_ids TEXT,
  metadata TEXT,
  risk_result TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- Double Ratchet 狀態
CREATE TABLE IF NOT EXISTS ratchet_states (
  peer_pubkey TEXT PRIMARY KEY,
  state_blob TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 待發送訊息佇列
CREATE TABLE IF NOT EXISTS pending_messages (
  id TEXT PRIMARY KEY,
  recipient_pubkey TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  message_type TEXT NOT NULL,
  original_content TEXT,
  created_at INTEGER NOT NULL,
  retry_count INTEGER DEFAULT 0,
  last_retry_at INTEGER
);

-- 邀請連結
CREATE TABLE IF NOT EXISTS invite_links (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  used_by TEXT,
  used_at INTEGER
);

-- 群組
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  group_type TEXT,
  guardian_settings TEXT
);

-- 群組成員
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  nickname TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, pubkey),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- 群組訊息
CREATE TABLE IF NOT EXISTS group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_pubkey TEXT NOT NULL,
  sender_name TEXT,
  content TEXT NOT NULL,
  msg_type TEXT NOT NULL DEFAULT 'text',
  created_at INTEGER NOT NULL,
  ttl INTEGER DEFAULT 0,
  expires_at INTEGER,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
);

-- 群組共享金鑰 (ADR-016)
CREATE TABLE IF NOT EXISTS group_keys (
  group_id TEXT NOT NULL,
  key_id TEXT NOT NULL PRIMARY KEY,
  key_base64 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  is_rotation INTEGER NOT NULL DEFAULT 0,
  distributor TEXT,
  stored_seq INTEGER,
  decrypt_only INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_group_keys_group_id ON group_keys(group_id);
CREATE INDEX IF NOT EXISTS idx_group_keys_active ON group_keys(group_id, is_active);

-- 系統黑名單（VPS 規則快取）
CREATE TABLE IF NOT EXISTS system_blacklist (
  domain TEXT PRIMARY KEY,
  severity REAL DEFAULT 0,
  category TEXT,
  source TEXT DEFAULT 'vps',
  updated_at INTEGER
);

-- 系統白名單
CREATE TABLE IF NOT EXISTS system_whitelist (
  domain TEXT PRIMARY KEY,
  category TEXT,
  source TEXT DEFAULT 'vps',
  updated_at INTEGER
);

-- YAML 規則
CREATE TABLE IF NOT EXISTS yaml_rules (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  severity TEXT,
  enabled INTEGER DEFAULT 1,
  updated_at INTEGER
);

-- 風險關鍵詞
CREATE TABLE IF NOT EXISTS risk_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  category TEXT,
  base_score INTEGER DEFAULT 50,
  needs_context INTEGER DEFAULT 0,
  source TEXT DEFAULT 'vps'
);

-- 同步 metadata
CREATE TABLE IF NOT EXISTS sync_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 通用 key-value 設定（取代 localStorage）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 使用者域名黑名單
CREATE TABLE IF NOT EXISTS user_blacklist (
  domain TEXT PRIMARY KEY,
  reason TEXT,
  source TEXT DEFAULT 'manual',
  added_at INTEGER NOT NULL
);

-- 使用者域名白名單
CREATE TABLE IF NOT EXISTS user_whitelist (
  domain TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);

-- 本地使用者黑名單（pubkey 封鎖）
CREATE TABLE IF NOT EXISTS local_user_blacklist (
  pubkey_hash TEXT PRIMARY KEY,
  reason TEXT,
  complaint_type TEXT,
  reported INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 守護人警報
CREATE TABLE IF NOT EXISTS guardian_alerts (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read INTEGER DEFAULT 0
);

-- 報平安記錄
CREATE TABLE IF NOT EXISTS checkin_records (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  member_pubkey TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

-- 下載歷史
CREATE TABLE IF NOT EXISTS download_history (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  url TEXT,
  size INTEGER,
  mime_type TEXT,
  created_at INTEGER NOT NULL
);
`;

/** 索引語句 */
const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_peer ON conversations(peer_pubkey);
CREATE INDEX IF NOT EXISTS idx_pending_recipient ON pending_messages(recipient_pubkey);
CREATE INDEX IF NOT EXISTS idx_invite_links_status ON invite_links(status);
CREATE INDEX IF NOT EXISTS idx_invite_links_expires ON invite_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_group_members_pubkey ON group_members(pubkey);
CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id);
CREATE INDEX IF NOT EXISTS idx_group_messages_created ON group_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_system_blacklist_category ON system_blacklist(category);
CREATE INDEX IF NOT EXISTS idx_risk_keywords_category ON risk_keywords(category);
CREATE INDEX IF NOT EXISTS idx_checkin_group ON checkin_records(group_id);
CREATE INDEX IF NOT EXISTS idx_checkin_member ON checkin_records(member_pubkey);
CREATE INDEX IF NOT EXISTS idx_guardian_alerts_group ON guardian_alerts(group_id);
`;

// ============================================
// 初始化
// ============================================

/**
 * 初始化統一資料庫
 * 必須在 App 啟動時呼叫一次
 */
export async function initDatabase(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = _doInit();
  try {
    await initPromise;
  } finally {
    // Always clear initPromise so a retry is possible after transient failure
    initPromise = null;
  }
}

/** Promise 超時包裝：防止底層 promise 永不 resolve（如 jeep-sqlite 的 open()） */
function _withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function _doInit(): Promise<void> {
  const t0 = Date.now();
  // Electron 在 Capacitor 8 + @capacitor-community/electron v5 上 isNativePlatform()=true,
  // 但我們不註冊 native sqlite plugin(避開 better-sqlite3 + Python 3.13 distutils 撞牆),
  // 必須強制走 web 路徑(jeep-sqlite + IndexedDB),否則 jeepSqliteElement 不會被 set,
  // 後續 query 撞 "jeep-sqlite element is not present in the DOM"。
  const platform = Capacitor.getPlatform();
  isWeb = !isNativeApp() || platform === 'electron';
  devLog(`[DIAG] DB init starting (platform=${platform}, mode=${isWeb ? 'web' : 'native'})...`);
  devLog(`[DB] Initializing database (platform=${platform}, mode=${isWeb ? 'web' : 'native'})...`);

  // Web 平台需要先初始化 web store（jeep-sqlite）
  if (isWeb) {
    // 等待 jeep-sqlite custom element 完全就緒
    devLog('[DB] Waiting for jeep-sqlite custom element...');
    await customElements.whenDefined('jeep-sqlite');
    const jeepEl = document.querySelector('jeep-sqlite') as HTMLElement & {
      isStoreOpen?: () => Promise<boolean>;
      wasmPath?: string;
    };

    // 設定 wasmPath：sql-wasm.wasm 在根目錄（public/sql-wasm.wasm → dist/sql-wasm.wasm）
    // jeep-sqlite 預設 wasmPath="/assets"，但我們的 WASM 在根目錄
    if (jeepEl) {
      jeepEl.wasmPath = '';
    }

    if (jeepEl && jeepEl.isStoreOpen) {
      // 等待 IndexedDB store 開啟（jeep-sqlite 的 connectedCallback 是 async）
      let storeOpened = false;
      for (let i = 0; i < 30; i++) {
        const open = await jeepEl.isStoreOpen();
        if (open) { storeOpened = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!storeOpened) {
        console.error('[DB] jeep-sqlite store failed to open after 3s');
        throw new Error('jeep-sqlite store failed to open after 3s');
      }
      devLog('[DB] jeep-sqlite store opened');
    }
    await CapacitorSQLite.initWebStore();
    devLog('[DB] Web store initialized');

    // ★ 真因修（port 自 AegisTalk database.ts:475-498，第零守則）：jeep-sqlite open() 若
    //   getDBFromStore 回 null（store 還沒把該 DB 從 IndexedDB 載好）會「建空 DB 並
    //   setInitialDBToStore 寫回」→ 永久覆寫掉 IndexedDB 既有資料（jeep-sqlite.entry.js:5562-5571）。
    //   所以 returning user 必須先「確認 DB 真的在 store 裡」(getDatabaseList) 再 open，否則第一次
    //   open 就把資料毀了（reopen/re-import 都救不回，因為已被覆寫成空）。Electron + 慢速 IndexedDB
    //   冷啟動最容易中。AegisTrans 用 aegistrans_keys（加密 identity keys）當 returning-user 標記
    //   （對應 AegisTalk 的 mist_keys）；mist_keys 一併查 legacy 相容。
    let isReturningUser = false;
    try {
      isReturningUser = typeof localStorage !== 'undefined'
        && (!!localStorage.getItem('aegistrans_keys') || !!localStorage.getItem('mist_keys'));
    } catch { /* localStorage 不可用 */ }
    if (isReturningUser) {
      // 冷啟動 flake 修（review 2026-07-17，第零守則抄 AegisTalk database.ts:539-563）：AegisTrans 舊
      // port 只 poll 一次 15s 就 throw —— jeep 暫時讀不到 DB 就直接放棄 → 冷啟動偶發「拒絕 open、暫時
      // 上不了線」（Playwright 要 retry 才過）。AegisTalk 有**復原**且 AegisTrans 港丟了：15s 沒到 →
      // 直接讀原始 IndexedDB 看 blob 在不在 → 在（資料真在、只是 jeep 一時讀不到）→ 重置 web store +
      // 再 poll 一次 → 仍不到才 throw（絕不空覆寫毀資料）；不在 → 放行建新 DB（真的全新使用者，安全）。
      const t0poll = Date.now();
      let found = await _pollDbInStore(15000);
      console.error(`[DIAG:DB:COLDSTART] first-poll elapsed=${Date.now() - t0poll}ms found=${found}`);
      if (!found) {
        // review #5 三態:_rawIdbBlobState 回 present/absent/unknown。**只有明確 absent 才放行 open()**;
        // present → 復原;unknown（raw 讀取本身失敗:open/timeout/tx error）→ **絕不放行 open**（無法確認資料
        // 在不在,放行 = 可能空覆寫毀資料）→ throw 讓上層重載重試。舊碼把 unknown 當 absent 是 fail-open。
        const raw = await _rawIdbBlobState();
        console.error(`[DIAG:DB:COLDSTART] raw IndexedDB blob state=${raw}`);
        if (raw === 'present') {
          console.error('[DIAG:DB] raw IndexedDB 有 blob 但 jeep 讀不到 → 重置 web store 並延長輪詢（拒絕空覆寫）');
          try { await CapacitorSQLite.initWebStore(); } catch (e) { console.error('[DIAG:DB] initWebStore retry err:', (e as Error)?.message); }
          found = await _pollDbInStore(15000);
          console.error(`[DIAG:DB:COLDSTART] second-poll found=${found} total=${Date.now() - t0poll}ms`);
          if (!found) {
            // 資料確定還在,但 jeep 始終載不進 store → 中止初始化（上層 ErrorBoundary 重試/重載）,
            // 絕不讓 open() 空覆寫毀掉既有 IndexedDB 資料（訊息/group keys）。
            throw new Error('DB_NOT_LOADED: 既有本機資料庫尚未載入，已拒絕開啟以避免覆寫。請重新載入再試。');
          }
        } else if (raw === 'unknown') {
          // raw inspection 本身失敗 → 無法確認資料狀態 → fail-closed,絕不 open。
          throw new Error('DB_UNKNOWN: 無法確認本機資料庫狀態（IndexedDB 讀取失敗），已拒絕開啟以避免覆寫。請重新載入再試。');
        } else {
          console.error('[DIAG:DB] raw IndexedDB 確定無 blob（absent）→ 視為全新使用者，放行 open() 建新 DB');
        }
      }
      console.error('[DIAG:DB] returning user DB check done（確認後才 open，避免空覆寫）');
    }
  }

  // 清理可能殘留的舊連線（Android Activity 重建、WebView 重載時 native plugin 保留連線但 JS 狀態已重置）
  // 加 timeout 防止 native plugin 處於死鎖狀態時永久掛起
  devLog('[DIAG] DB cleanup stale connections...');
  try {
    await _withTimeout(
      CapacitorSQLite.close({ database: DB_NAME }),
      3000,
      'close() timed out (stale connection cleanup)',
    );
    devLog('[DIAG] DB close() succeeded (had stale DB)');
  } catch {
    // 忽略：尚無開啟的 DB 或超時
  }
  try {
    await _withTimeout(
      CapacitorSQLite.closeConnection({ database: DB_NAME }),
      3000,
      'closeConnection() timed out (stale connection cleanup)',
    );
    devLog('[DIAG] DB closeConnection() succeeded (had stale connection)');
  } catch {
    // 忽略：尚無連線或超時
  }

  // SQLCipher encryption (native only — sql.js/web doesn't support SQLCipher)
  // 必須跟 capacitor.config.ts 的 `androidIsEncryption` / `iosIsEncryption` 對齊：
  // 那邊是 false，所以這裡也要走 no-encryption。否則 setEncryptionSecret /
  // createConnection({encrypted:true}) 會被 plugin 直接拒絕，錯誤訊息：
  //   "CreateConnection: Database cannot be encrypted as 'No Encryption' set in capacitor.config"
  let useEncryption = !isWeb;
  if (useEncryption) {
    try {
      const { result } = await CapacitorSQLite.isSecretStored();
      if (!result) {
        const passBytes = crypto.getRandomValues(new Uint8Array(32));
        const passphrase = Array.from(passBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        await CapacitorSQLite.setEncryptionSecret({ passphrase });
        devLog('[DB] Encryption secret generated and stored');
      } else {
        devLog('[DB] Encryption secret already stored');
      }
    } catch (err) {
      // capacitor.config 把 encryption 關掉時 isSecretStored / setEncryptionSecret 會 throw —
      // 真的把 useEncryption flip 成 false，後面 createConnection 才不會用衝突的參數。
      console.error('[DB] Failed to set encryption secret, falling back to no-encryption:', err);
      useEncryption = false;
    }
  }

  // 建立連線（加 timeout 防止首次啟動時 native plugin 未就緒）
  devLog('[DIAG] DB createConnection... (encrypted=' + useEncryption + ')');
  devLog('[DB] Creating connection...');
  await _withTimeout(
    CapacitorSQLite.createConnection({
      database: DB_NAME,
      version: SCHEMA_VERSION,
      encrypted: useEncryption,
      mode: useEncryption ? 'secret' : 'no-encryption',  // oss-scan: allow（模式名稱，不是密鑰）
    }),
    10000,
    'CapacitorSQLite.createConnection() timed out after 10s',
  );
  devLog('[DIAG] DB createConnection OK');

  // 開啟資料庫（加 timeout 防止 jeep-sqlite 內部 promise 永不 resolve）
  devLog('[DIAG] DB open...');
  devLog('[DB] Opening database...');
  await _withTimeout(
    CapacitorSQLite.open({ database: DB_NAME }),
    10000,
    'CapacitorSQLite.open() timed out after 10s'
  );
  devLog('[DIAG] DB open OK');

  // 建立基礎 schema（CREATE TABLE IF NOT EXISTS 確保冪等）
  devLog('[DIAG] DB schema...');
  devLog('[DB] Executing schema SQL...');
  await CapacitorSQLite.execute({
    database: DB_NAME,
    statements: SCHEMA_SQL,
    transaction: false,
  });
  devLog('[DIAG] DB schema OK');

  // 建立索引
  await CapacitorSQLite.execute({
    database: DB_NAME,
    statements: INDEX_SQL,
    transaction: false,
  });

  // 執行增量遷移
  devLog('[DIAG] DB migrations...');
  await _runMigrations();
  devLog('[DIAG] DB migrations OK');

  // Web 平台需要保存到 store
  if (isWeb) {
    await CapacitorSQLite.saveToStore({ database: DB_NAME });
  }

  initialized = true;
  devLog(`[DIAG] DB initialized OK in ${Date.now() - t0}ms`);
  devLog(`[DB] Database initialized in ${Date.now() - t0}ms`);

  // Diagnostic: dump key table counts
  try {
    const tables = ['contacts', 'messages', 'groups', 'settings', 'system_blacklist', 'system_whitelist', 'ratchet_states'];
    for (const t of tables) {
      validateTableName(t);
      const r = await CapacitorSQLite.query({ database: DB_NAME, statement: `SELECT COUNT(*) as cnt FROM ${t}`, values: [] });
      devLog(`[DIAG] Table ${t}: ${r.values?.[0]?.cnt ?? 'N/A'} rows`);
    }
  } catch (e) {
    devLog('[DIAG] Table count query failed:', e);
  }

  // 清理舊的 IndexedDB 資料庫（一次性，不阻塞）
  _cleanupOldDatabases();
}

/**
 * 輪詢 jeep 的 getDatabaseList()，確認本 DB 是否已被 jeep 的 localForage 實例載入 store。
 * 回 true = 在 store 內（open 安全，不會空覆寫）。read-only，不改任何狀態。
 * （第零守則 port 自 AegisTalk database.ts:726-738）
 */
async function _pollDbInStore(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; Date.now() < deadline; i++) {
    try {
      const list = await CapacitorSQLite.getDatabaseList();
      const arr: string[] = (list?.values as string[]) ?? [];
      if (arr.some((d) => typeof d === 'string' && d.includes(DB_NAME))) return true;
      if (i % 5 === 0) console.error(`[DIAG:DB] returning user — 等 DB 進 store (list=${JSON.stringify(arr)})`);
    } catch (e) { if (i % 5 === 0) console.error('[DIAG:DB] getDatabaseList err:', (e as Error)?.message); }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

type RawBlobState = 'present' | 'absent' | 'unknown';

/**
 * 繞過 jeep 的 localForage 實例，直接讀原始 IndexedDB，判斷 jeep getDatabaseList()=[] 時 DB blob 狀態。
 * **三態**（review #5，2026-07-17）:
 *   'present' = IndexedDB 內有本 DB 的非空 blob（資料確實還在、jeep 暫時讀不到 → 絕不可空覆寫）。
 *   'absent'  = 確定沒有本 DB blob（jeepSqliteStore/databases store 不存在、或無此 key、或 blob 為空）
 *               → 真全新使用者 / 從未持久化 → open() 建新 DB 安全。
 *   'unknown' = raw inspection 本身失敗（indexedDB 不可用 / open error / timeout / tx / 讀值 error）
 *               → 無法判定 → 呼叫端**絕不可放行 open()**（可能空覆寫）→ 應 throw 重試。
 * read-only，不改任何狀態、不建 object store（jeepSqliteStore 不存在時 abort upgrade，不留下空 store）。
 * console.error 以存活 prod build。（第零守則 port 自 AegisTalk，並加固為三態）
 */
async function _rawIdbBlobState(): Promise<RawBlobState> {
  if (typeof indexedDB === 'undefined') { console.error('[DIAG:DB:RAW] no indexedDB → unknown'); return 'unknown'; }
  try {
    const dbs = (indexedDB as { databases?: () => Promise<Array<{ name?: string; version?: number }>> }).databases;
    if (typeof dbs === 'function') {
      const list = await dbs.call(indexedDB);
      console.error(`[DIAG:DB:RAW] indexedDB.databases()=${JSON.stringify(list.map((d) => `${d.name}@v${d.version}`))}`);
    } else {
      console.error('[DIAG:DB:RAW] indexedDB.databases() unsupported');
    }
  } catch (e) { console.error('[DIAG:DB:RAW] databases() err:', (e as Error)?.message); }
  return await new Promise<RawBlobState>((resolve) => {
    let settled = false;
    const done = (s: RawBlobState) => { if (!settled) { settled = true; resolve(s); } };
    try {
      const req = indexedDB.open('jeepSqliteStore');
      req.onerror = () => { console.error('[DIAG:DB:RAW] open jeepSqliteStore err → unknown'); done('unknown'); };
      req.onupgradeneeded = () => {
        // jeepSqliteStore 從不存在 = 從未持久化任何 jeep DB = 真新使用者（absent）。
        // read-only 契約:abort upgrade，不留下這顆空 store。
        console.error('[DIAG:DB:RAW] jeepSqliteStore did NOT exist → absent（aborting upgrade, no store created）');
        try { req.transaction?.abort(); } catch { /* abort 觸發 onerror，已由 settled 擋重複 resolve */ }
        done('absent');
      };
      req.onsuccess = () => {
        try {
          const idb = req.result;
          const stores = Array.from(idb.objectStoreNames);
          console.error(`[DIAG:DB:RAW] jeepSqliteStore objectStores=${JSON.stringify(stores)}`);
          if (!stores.includes('databases')) { idb.close(); done('absent'); return; }
          const tx = idb.transaction('databases', 'readonly');
          const os = tx.objectStore('databases');
          const keysReq = os.getAllKeys();
          keysReq.onsuccess = () => {
            const keys = (keysReq.result as IDBValidKey[]).map(String);
            console.error(`[DIAG:DB:RAW] databases store keys=${JSON.stringify(keys)}`);
            const dbKey = keys.find((k) => k.includes(DB_NAME));
            if (!dbKey) { idb.close(); done('absent'); return; }
            const valReq = os.get(dbKey);
            valReq.onsuccess = () => {
              const v = valReq.result;
              let sz = 'null';
              let present = false;
              if (v instanceof Uint8Array) { sz = `Uint8Array(${v.byteLength})`; present = v.byteLength > 0; }
              else if (v instanceof ArrayBuffer) { sz = `ArrayBuffer(${v.byteLength})`; present = v.byteLength > 0; }
              else if (typeof v === 'string') { sz = `string(${v.length})`; present = v.length > 0; }
              else if (v != null) { sz = typeof v; present = true; }
              console.error(`[DIAG:DB:RAW] blob '${dbKey}' value=${sz} → ${present ? 'present' : 'absent'}`);
              idb.close(); done(present ? 'present' : 'absent');
            };
            valReq.onerror = () => { console.error('[DIAG:DB:RAW] get blob err → unknown'); idb.close(); done('unknown'); };
          };
          keysReq.onerror = () => { console.error('[DIAG:DB:RAW] getAllKeys err → unknown'); idb.close(); done('unknown'); };
        } catch (e) { console.error('[DIAG:DB:RAW] inner err → unknown:', (e as Error)?.message); done('unknown'); }
      };
    } catch (e) { console.error('[DIAG:DB:RAW] open err → unknown:', (e as Error)?.message); done('unknown'); }
    setTimeout(() => done('unknown'), 3000);
  });
}

/**
 * 清理舊的 IndexedDB 資料庫
 * 遷移到統一 SQLite 後，舊資料庫不再需要
 */
function _cleanupOldDatabases(): void {
  if (typeof indexedDB === 'undefined') return;
  const OLD_DBS = ['mist_storage', 'aegis-talk-rules'];
  for (const name of OLD_DBS) {
    try {
      indexedDB.deleteDatabase(name);
    } catch {
      // 忽略
    }
  }
}

/**
 * 增量遷移系統
 *
 * 1. 讀取 sync_metadata 中的 'schema_version' 取得目前版本
 * 2. 依序執行 version > currentVersion 的 migration SQL
 * 3. 更新 schema_version 到最新
 *
 * 確保冪等：每個 migration 只執行一次
 */
async function _runMigrations(): Promise<void> {
  // 讀取目前版本
  const versionResult = await CapacitorSQLite.query({
    database: DB_NAME,
    statement: "SELECT value FROM sync_metadata WHERE key = 'schema_version'",
    values: [],
  });

  let currentVersion = 1; // 預設為 1（初始 schema）
  // iOS 同樣有 ios_columns metadata 列，需剝除（否則 version 永遠讀成 NaN→1，每次重跑 migrations）
  const versionRows = stripIosColumnsRow(versionResult.values ?? []) as Array<{ value?: unknown }>;
  if (versionRows.length > 0) {
    const stored = parseInt(String(versionRows[0].value), 10);
    if (!isNaN(stored)) {
      currentVersion = stored;
    }
  }

  // 找出需要執行的遷移
  const pendingMigrations = MIGRATIONS
    .filter(m => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (pendingMigrations.length === 0) {
    devLog(`[DB] Schema up to date (v${currentVersion})`);
    // 確保版本號已記錄
    await CapacitorSQLite.run({
      database: DB_NAME,
      statement: "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('schema_version', ?)",
      values: [String(SCHEMA_VERSION)],
      transaction: false,
    });
    return;
  }

  devLog(`[DB] Running ${pendingMigrations.length} migration(s): v${currentVersion} → v${SCHEMA_VERSION}`);

  // 依序執行遷移
  for (const migration of pendingMigrations) {
    try {
      devLog(`[DB] Migrating to v${migration.version}: ${migration.description}`);

      // Individual statements: each runs separately, tolerating "duplicate column" errors
      if (migration.individualStatements && migration.individualStatements.length > 0) {
        for (const stmt of migration.individualStatements) {
          try {
            await CapacitorSQLite.execute({
              database: DB_NAME,
              statements: stmt + ';',
              transaction: false,
            });
          } catch (stmtErr) {
            const stmtMsg = stmtErr instanceof Error ? stmtErr.message : String(stmtErr);
            if (stmtMsg.includes('duplicate column')) {
              devLog(`[DB] Column already exists, skipping: ${stmt}`);
            } else {
              throw stmtErr; // Re-throw non-duplicate errors
            }
          }
        }
      } else if (migration.sql) {
        await CapacitorSQLite.execute({
          database: DB_NAME,
          statements: migration.sql,
          transaction: true,
        });
      }

      // 更新版本號
      await CapacitorSQLite.run({
        database: DB_NAME,
        statement: "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES ('schema_version', ?)",
        values: [String(migration.version)],
        transaction: false,
      });
      devLog(`[DB] Migration v${migration.version} completed`);
    } catch (error) {
      // 遷移失敗：記錄 breadcrumb（version 不前進 → 下次啟動會重試）
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[DB] Migration v${migration.version} FAILED: ${msg}`);
      await CapacitorSQLite.run({
        database: DB_NAME,
        statement: "INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)",
        values: [`migration_error_v${migration.version}`, `${Date.now()}:${msg}`],
        transaction: false,
      });
      // 核心 migration（建 core flow 依賴表）失敗 → 不可靜默以半套 schema 啟動，
      // re-throw 讓 _doInit 走 error 路徑（initPromise 清掉、可重試），下游不會在離成因
      // 很遠處炸。非核心（fork 死表 ALTER）維持原本「break、不阻擋啟動」。
      if (migration.critical) {
        throw new Error(`Critical migration v${migration.version} failed: ${msg}`);
      }
      break; // 非核心：停止後續遷移但不阻擋啟動
    }
  }
}

// ============================================
// 核心 CRUD 操作
// ============================================

/**
 * 執行批量 SQL（不回傳資料）
 * 適合 CREATE TABLE / INSERT 批量操作
 */
export async function execute(statements: string, transaction = true): Promise<number> {
  await initDatabase();
  const result = await CapacitorSQLite.execute({
    database: DB_NAME,
    statements,
    transaction,
  });
  if (isWeb) {
    await CapacitorSQLite.saveToStore({ database: DB_NAME });
  }
  return result.changes?.changes ?? 0;
}

/**
 * 執行單一 SQL 語句（帶參數）
 * 適合 INSERT / UPDATE / DELETE
 */
export async function run(statement: string, values: unknown[] = []): Promise<number> {
  await initDatabase();
  const result = await CapacitorSQLite.run({
    database: DB_NAME,
    statement,
    values: values as (string | number | null)[],
    transaction: false,
  });
  if (isWeb) {
    await CapacitorSQLite.saveToStore({ database: DB_NAME });
  }
  return result.changes?.changes ?? 0;
}

/**
 * 查詢 SQL（帶參數，回傳列陣列）
 */
export async function query<T = Record<string, unknown>>(
  statement: string,
  values: unknown[] = [],
): Promise<T[]> {
  await initDatabase();
  const result = await CapacitorSQLite.query({
    database: DB_NAME,
    statement,
    values: values as (string | number | null)[],
  });
  // @capacitor-community/sqlite 在 iOS 上把欄位名 metadata 當 values[0]
  // 回傳（`{ios_columns:[...]}`），真資料從 values[1] 起。web/electron 無此列。
  // 不剝掉 → 所有 rows[0] 讀到的是 metadata（欄位全 undefined）→ iOS 上每個
  // SELECT 都錯位（group key / 訊息 / 裝置全壞）。偵測 marker 後剝除。
  return stripIosColumnsRow(result.values ?? []) as T[];
}

/** 剝除 iOS @capacitor-community/sqlite query 回傳的 `{ios_columns:[...]}` metadata 列。 */
function stripIosColumnsRow(rows: unknown[]): unknown[] {
  if (
    rows.length > 0 &&
    rows[0] != null &&
    typeof rows[0] === 'object' &&
    'ios_columns' in (rows[0] as Record<string, unknown>)
  ) {
    return rows.slice(1);
  }
  return rows;
}

/**
 * 查詢單一列
 */
export async function queryOne<T = Record<string, unknown>>(
  statement: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(statement, values);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 交易（批量操作）
 */
export async function transaction(fn: () => Promise<void>): Promise<void> {
  await initDatabase();
  await CapacitorSQLite.beginTransaction({ database: DB_NAME });
  try {
    await fn();
    await CapacitorSQLite.commitTransaction({ database: DB_NAME });
    if (isWeb) {
      await CapacitorSQLite.saveToStore({ database: DB_NAME });
    }
  } catch (error) {
    await CapacitorSQLite.rollbackTransaction({ database: DB_NAME });
    throw error;
  }
}

/**
 * 批量執行（使用 executeSet）— 適合大量 INSERT
 */
export async function runBatch(
  sets: Array<{ statement: string; values: (string | number | null)[] }>,
): Promise<number> {
  await initDatabase();
  const result = await CapacitorSQLite.executeSet({
    database: DB_NAME,
    set: sets,
    transaction: true,
  });
  if (isWeb) {
    await CapacitorSQLite.saveToStore({ database: DB_NAME });
  }
  return result.changes?.changes ?? 0;
}

/**
 * 執行單一 SQL 但不自動 saveToStore（用於 transaction 內部）
 * 避免 59 萬筆 INSERT 每筆都 saveToStore
 */
export async function runNoSave(statement: string, values: unknown[] = []): Promise<number> {
  await initDatabase();
  const result = await CapacitorSQLite.run({
    database: DB_NAME,
    statement,
    values: values as (string | number | null)[],
    transaction: false,
  });
  return result.changes?.changes ?? 0;
}

/** Validate table name to prevent SQL injection (only allows [a-z0-9_]) */
function validateTableName(table: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Invalid table name: ${table}`);
  }
}

/**
 * 取得指定表格的 row count
 */
export async function getCount(table: string): Promise<number> {
  validateTableName(table);
  const row = await queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
  return row?.cnt ?? 0;
}

/**
 * 清空指定表格
 */
export async function clearTable(table: string): Promise<void> {
  validateTableName(table);
  await run(`DELETE FROM ${table}`);
}

// ============================================
// Settings 通用 Key-Value 操作
// ============================================

/**
 * 取得設定值
 */
export async function getSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

/**
 * 設定值
 */
export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
    [key, value, Date.now()],
  );
}

/**
 * 刪除設定
 */
export async function deleteSetting(key: string): Promise<void> {
  await run('DELETE FROM settings WHERE key = ?', [key]);
}

/**
 * 從 localStorage 遷移到 SQLite settings
 * 每個 key 只遷移一次：若 SQLite 已有則跳過
 */
export async function migrateFromLocalStorage(
  localStorageKey: string,
  sqliteKey?: string,
): Promise<void> {
  const targetKey = sqliteKey ?? localStorageKey;
  const existing = await getSetting(targetKey);
  if (existing !== null) return; // 已遷移

  try {
    const old = localStorage.getItem(localStorageKey);
    if (old !== null) {
      await setSetting(targetKey, old);
      localStorage.removeItem(localStorageKey);
    }
  } catch {
    // localStorage 存取失敗（隱私模式等），忽略
  }
}

// ============================================
// 待發送訊息佇列 (pending_messages) — P2P 持久化 outbox
// port 自 AegisTalk storage.ts（第零守則）；改用本檔的 query/run/queryOne
// （那些已內含 initDatabase()，不需再手動 init）。
// ============================================

export interface PendingMessage {
  id: string;
  recipientPubkey: string;
  encryptedPayload: string;
  messageType: string;
  originalContent?: string;
  createdAt: number;
  retryCount: number;
  lastRetryAt: number | null;
}

interface PendingMessageRow {
  id: string;
  recipient_pubkey: string;
  encrypted_payload: string;
  message_type: string;
  original_content: string | null;
  created_at: number;
  retry_count: number;
  last_retry_at: number | null;
}

function rowToPendingMessage(row: PendingMessageRow): PendingMessage {
  return {
    id: row.id,
    recipientPubkey: row.recipient_pubkey,
    encryptedPayload: row.encrypted_payload,
    messageType: row.message_type,
    originalContent: row.original_content || undefined,
    createdAt: row.created_at,
    retryCount: row.retry_count,
    lastRetryAt: row.last_retry_at,
  };
}

export async function addPendingMessage(
  message: Omit<PendingMessage, 'retryCount' | 'lastRetryAt'>,
): Promise<void> {
  await run(
    `INSERT OR REPLACE INTO pending_messages
     (id, recipient_pubkey, encrypted_payload, message_type, original_content, created_at, retry_count, last_retry_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    [
      message.id,
      message.recipientPubkey,
      message.encryptedPayload,
      message.messageType,
      message.originalContent || null,
      message.createdAt,
    ],
  );
}

export async function getPendingMessagesForRecipient(recipientPubkey: string): Promise<PendingMessage[]> {
  const rows = await query<PendingMessageRow>(
    `SELECT id, recipient_pubkey, encrypted_payload, message_type, original_content, created_at, retry_count, last_retry_at
     FROM pending_messages WHERE recipient_pubkey = ? ORDER BY created_at ASC`,
    [recipientPubkey],
  );
  return rows.map(rowToPendingMessage);
}

export async function getAllPendingMessages(): Promise<PendingMessage[]> {
  const rows = await query<PendingMessageRow>(
    `SELECT id, recipient_pubkey, encrypted_payload, message_type, original_content, created_at, retry_count, last_retry_at
     FROM pending_messages ORDER BY created_at ASC`,
  );
  return rows.map(rowToPendingMessage);
}

export async function removePendingMessage(messageId: string): Promise<void> {
  await run(`DELETE FROM pending_messages WHERE id = ?`, [messageId]);
}

/** outbox 裡有排隊訊息的收件者（不重複；不讀訊息內容——每次成功抓到裝置清單都會問，AegisTrans 審查 E） */
export async function getPendingRecipients(): Promise<string[]> {
  const rows = await query<{ recipient_pubkey: string }>(`SELECT DISTINCT recipient_pubkey FROM pending_messages`);
  return rows.map((row) => row.recipient_pubkey);
}

/** 刪掉某 peer 的全部待送（撤銷裝置時用）。回傳刪除筆數。 */
export async function deletePendingMessagesForRecipient(recipientPubkey: string): Promise<number> {
  return run(`DELETE FROM pending_messages WHERE recipient_pubkey = ?`, [recipientPubkey]);
}

export async function updatePendingMessageRetry(messageId: string): Promise<void> {
  await run(
    `UPDATE pending_messages SET retry_count = retry_count + 1, last_retry_at = ? WHERE id = ?`,
    [Date.now(), messageId],
  );
}

export async function getPendingMessageCount(recipientPubkey?: string): Promise<number> {
  if (recipientPubkey) {
    const row = await queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM pending_messages WHERE recipient_pubkey = ?`,
      [recipientPubkey],
    );
    return row?.cnt ?? 0;
  }
  const row = await queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM pending_messages`);
  return row?.cnt ?? 0;
}

/** outbox 統計（給 UI 顯示）— 只 COUNT，不撈 payload（SettingsPage 每 5s 輪詢，別全表掃）。 */
export async function getPendingMessageStats(): Promise<{ totalMessages: number; peersAwaiting: number }> {
  const row = await queryOne<{ total: number; peers: number }>(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT recipient_pubkey) AS peers FROM pending_messages`,
  );
  return { totalMessages: row?.total ?? 0, peersAwaiting: row?.peers ?? 0 };
}

// 持久化 outbox TTL：30 天（§0.29「訊息絕不消失」— server 不緩存，全靠 sender 本機 buffer）。
const PENDING_MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function cleanupOldPendingMessages(): Promise<number> {
  const cutoff = Date.now() - PENDING_MESSAGE_TTL_MS;
  return run(`DELETE FROM pending_messages WHERE created_at < ?`, [cutoff]);
}

// ============================================
// 關閉
// ============================================

/**
 * 關閉資料庫連線
 */
export async function closeDatabase(): Promise<void> {
  if (!initialized) return;

  if (isWeb) {
    await CapacitorSQLite.saveToStore({ database: DB_NAME });
  }
  await CapacitorSQLite.close({ database: DB_NAME });
  await CapacitorSQLite.closeConnection({ database: DB_NAME });
  initialized = false;
}

/**
 * Web 平台：手動保存到 IndexedDB store
 * 原生平台不需要（自動持久化）
 */
export async function saveIfWeb(): Promise<void> {
  if (isWeb && initialized) {
    await CapacitorSQLite.saveToStore({ database: DB_NAME });
  }
}
