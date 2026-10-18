/**
 * 「這把公鑰還是不是本帳號的裝置」—— 撤銷裝置要真的切斷（稽核 B1／B10，對應 TofuTalk 142fc5c）。
 *
 * 被撤的裝置在 MQTT token 過期前（≤1h）仍能發訊，手上也還有舊的 ratchet session。以前配對（PREKEY_REQUEST／
 * PRE_KEY_BUNDLE／X3DH_INIT）、MQTT 上的金鑰分發、WebRTC offer、DataChannel 內容都不檢查，於是它能重新配對
 * 拿到「輪換後」的新金鑰、塞一把自己的金鑰當成 active，其他裝置也照樣對它廣播。現在這些入口都問同一個檢查。
 *
 * App.tsx 在 jwt 到位時 setAccountDeviceCheck。沒設定時一律放行（只跑單一模組的測試／啟動前的空窗）；
 * 檢查本身出錯則當成「不是」。
 */
export type AccountDeviceCheck = ((peer: string) => Promise<boolean>) & {
  invalidate?: () => void;
  /**
   * 別處抓到的成功清單（PWA：auth.onDeviceListFetched）；startedAt＝那次請求開始時的 stamp()（跟檢查自己的重抓一起排先後）
   */
  observe?: (keys: readonly string[], startedAt: number) => void;
  /** 檢查自己的時鐘（單調、只增不減）上的現在：別處開始抓清單時取，抓到後連同清單交給 observe */
  stamp?: () => number;
  /** invalidate 之後要等確認的版本（配對、金鑰訊息）：被撤的裝置不能靠快取再配對或塞 key */
  strict?: (peer: string) => Promise<boolean>;
};

let check: AccountDeviceCheck | null = null;

export function setAccountDeviceCheck(fn: AccountDeviceCheck | null): void {
  check = fn;
}

export async function isAccountDevice(peer: string): Promise<boolean> {
  if (!check) return true;
  try {
    return await check(peer);
  } catch {
    return false;
  }
}

/**
 * 配對（PREKEY_REQUEST／PRE_KEY_BUNDLE／X3DH_INIT）與金鑰訊息用：roster ping（invalidate）之後要等清單確認，被撤的裝置
 * 不能靠快取再配對、塞 key 或要 key。其他入口（offer、ICE、資料幀）用 isAccountDevice（照快取回答，對應 TofuTalk afc85e8，
 * AegisTrans 審查 C）。
 */
export async function isConfirmedAccountDevice(peer: string): Promise<boolean> {
  if (!check) return true;
  try {
    return await (check.strict ?? check)(peer);
  } catch {
    return false;
  }
}

/** 裝置清單可能變了（roster ping、剛撤銷）：下一次檢查重抓，不等快取過期 */
export function invalidateAccountDevices(): void {
  check?.invalidate?.();
}

/**
 * 別處抓到的成功清單（PWA：auth.onDeviceListFetched，useAuth 每 20 秒一次）：檢查的快取最多舊 ~20 秒，不多打 API
 * （對應 TofuTalk aaaf536，審查 LOW-4）。startedAt＝那次請求開始時的 deviceListStamp()。
 */
export function observeFetchedDeviceList(keys: readonly string[], startedAt: number): void {
  check?.observe?.(keys, startedAt);
}

/**
 * 開始抓裝置清單時取（auth.listDevices）：檢查的時鐘上的現在；還沒有檢查時是 monotonicNow()（同一個時鐘）。
 * 對應 TofuTalk cf8f03d（審查 round-3 MEDIUM-2）。
 */
export function deviceListStamp(): number {
  return check?.stamp?.() ?? monotonicNow();
}

// ── 以下與 TofuTalk services/accountDevices.ts 的 accountDeviceCheck／accountDevicePersistence 相同（對應 TofuTalk
//    06fe74a、aaaf536、afc85e8、cf8f03d；AegisTrans 沒有 deviceRpc.ts 與 device agent）；goneDeviceTracker 對應 a08cc93。唯一差異：本機保存的
//    key 用 aegistrans_ 開頭。
//    TofuTalk 後續修正請照本段對應移植。

export interface AccountDeviceCheckOptions {
  /** 上一份成功的清單（本機保存）：第一次抓成功前就認得自己的裝置（冷啟動時 API 掛著） */
  seed?: readonly string[] | null;
  /** 每次抓成功都呼叫（保存清單） */
  onFetched?: (keys: readonly string[]) => void;
  /** 答案取決於重抓時（不認得的裝置、invalidate 之後）最多等多久；之後照快取回答 */
  maxWaitMs?: number;
  /** 預設 monotonicNow；注入的時鐘往回跳也不會讓檢查停住（forwardOnly） */
  now?: () => number;
}

/**
 * 排先後、算「多久以前」用的時鐘：單調（performance.now()），不跟著系統時間往回調（審查 round-3 MEDIUM-2：以前用
 * Date.now()，NTP 校正或手動改時間往回一小時，之後的清單一小時內都比已套用的「舊」而被丟——被撤的裝置照樣通過、
 * 新裝置一直被拒，快取年齡也變成負的、不再重抓）。沒有 performance 的環境才退回 Date.now()。
 */
export function monotonicNow(): number {
  const performanceNow = globalThis.performance?.now;
  return typeof performanceNow === 'function' ? performanceNow.call(globalThis.performance) : Date.now();
}

/** 讀到比上次小的值（注入的時鐘、退回的 Date.now() 往回調）：之後的讀數補上往回的量，只增不減 */
function forwardOnly(read: () => number): () => number {
  let last = -Infinity;
  let shift = 0;
  return () => {
    const raw = read();
    if (raw + shift < last) shift = last - raw;
    last = raw + shift;
    return last;
  };
}

const STALE_MS = 60_000;           // 認得的裝置：照快取回答，超過一分鐘在背景重抓
const ATTEMPT_SPACING_MS = 10_000; // 不認得的裝置／背景重試：每 10 秒最多重抓一次（陌生人灌不爆 API）
const MAX_WAIT_MS = 5_000;

interface Refresh {
  /** 開始時的 invalidate 世代 */
  generation: number;
  id: number;
  /** 重抓結束或等滿 maxWaitMs（同一次重抓的等待者共用同一個期限） */
  bounded: Promise<void>;
}

/**
 * isAccountDevice backed by the account's device list (審查 HIGH-2：GET /devices 慢或掛掉時不能卡住每個入口):
 * - known peer → answered from the cache at once; refreshed in the background after a minute, and right away after
 *   invalidate() (roster ping: every device's MQTT connect). Offers, ICE and data frames must not wait for GET /devices
 *   after every roster ping (AegisTrans 審查 C); a revoked peer is refused — and pruned — once the refresh lands;
 * - strict(): pairing and key messages — after invalidate() waits for a refresh that started after it, at most ~5 s,
 *   then answers from whatever the cache holds (only the first check per invalidate waits; an outage costs one
 *   bounded wait, later checks retry in the background);
 * - unknown peer (at most one refresh per 10 s; after invalidate like strict) → waits the same way;
 * - results apply in start order (a late older list never overwrites a newer one); a failed refresh keeps the last
 *   good list; with none (and no seed), nobody is trusted;
 * - lists fetched elsewhere (observe: useAuth's 20 s refresh) apply in the same start order, so cached answers are at
 *   most ~20 s old without extra fetches (審查 LOW-4); one counts as the post-invalidate confirmation only if it
 *   started after the invalidate. Their start is a stamp() of this check's clock (deviceListStamp);
 * - start order and ages use a monotonic clock, never the wall clock (審查 round-3 MEDIUM-2).
 */
export function accountDeviceCheck(list: () => Promise<string[]>, options: AccountDeviceCheckOptions = {}): AccountDeviceCheck {
  const now = forwardOnly(options.now ?? monotonicNow);
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  let known: ReadonlySet<string> = new Set(options.seed ?? []);
  let fetchedAt = -Infinity;       // 上次抓成功（seed 算過期 → 第一次檢查就在背景重抓）
  let lastAttemptAt = -Infinity;
  let generation = 0;              // invalidate() 每次 +1
  let invalidatedAt = -Infinity;   // 最近一次 invalidate() 的時間
  let freshGeneration = 0;         // 最新一次「抓成功」開始時的世代；< generation 代表 invalidate 後還沒確認
  let waitedGeneration = 0;        // 這個世代的那一次限時等待已經用掉
  let kickedGeneration = 0;        // 這個世代 invalidate 後的第一次重抓已經開始
  let lastId = 0;
  let appliedId = 0;
  let appliedStartedAt = -Infinity; // 目前這份清單開始抓的時間（自己的重抓與別處的清單一起比）
  let inflight: Refresh | null = null;

  /** 依開始抓的先後套用（同一毫秒再看自己的重抓編號；別處的清單 id＝null） */
  const apply = (startedAt: number, id: number | null, startedGeneration: number, keys: readonly string[]) => {
    if (startedAt > appliedStartedAt || (startedAt === appliedStartedAt && (id === null || id > appliedId))) {
      appliedStartedAt = startedAt;
      if (id !== null) appliedId = id;
      known = new Set(keys);
      fetchedAt = now();
      try { options.onFetched?.(keys); } catch { /* 存不進去不影響檢查 */ }
    }
    freshGeneration = Math.max(freshGeneration, startedGeneration);
  };

  const startRefresh = (): Refresh => {
    const id = ++lastId;
    const startedGeneration = generation;
    const startedAt = now();
    lastAttemptAt = startedAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); });
    const done = Promise.resolve()
      .then(list)
      .then((keys) => apply(startedAt, id, startedGeneration, keys), () => { /* 保留上一份清單 */ })
      .finally(() => {
        clearTimeout(timer);
        if (inflight?.id === id) inflight = null;
      });
    const refresh: Refresh = { generation: startedGeneration, id, bounded: Promise.race([done, deadline]) };
    inflight = refresh;
    return refresh;
  };

  const refreshInBackground = () => {
    if (!inflight && now() - lastAttemptAt >= ATTEMPT_SPACING_MS) startRefresh();
  };

  /** invalidate 之後還沒確認：等一次在它之後開始的重抓（每個世代只有第一次等，之後背景重試） */
  const confirm = async () => {
    if (waitedGeneration < generation) {
      const target = generation;
      kickedGeneration = Math.max(kickedGeneration, target);
      await (inflight?.generation === target ? inflight : startRefresh()).bounded;
      waitedGeneration = Math.max(waitedGeneration, target);
    } else {
      refreshInBackground();
    }
  };

  const check: AccountDeviceCheck = async (peer: string) => {
    if (freshGeneration < generation) {
      // invalidate（roster ping）之後：認得的照快取回答、背景重抓（invalidate 後第一次立刻抓，之後每 10 秒）；
      //   不認得的等一次重抓。被撤的那台在重抓落地後就不認（配對、金鑰訊息用 strict，稽核 B1）
      if (!known.has(peer)) {
        await confirm();
        return known.has(peer);
      }
      if (inflight?.generation !== generation) {
        if (kickedGeneration < generation) { kickedGeneration = generation; startRefresh(); } else refreshInBackground();
      }
      return true;
    }
    if (known.has(peer)) {
      if (now() - fetchedAt > STALE_MS) refreshInBackground();
      return true;
    }
    if (inflight) await inflight.bounded;
    else if (now() - lastAttemptAt >= ATTEMPT_SPACING_MS) await startRefresh().bounded;
    return known.has(peer);
  };
  check.strict = async (peer: string) => {
    if (freshGeneration < generation) {
      await confirm();
      return known.has(peer);
    }
    return check(peer);
  };
  check.invalidate = () => { generation++; invalidatedAt = now(); };
  check.stamp = now;
  check.observe = (keys, startedAt) => {
    if (keys.length === 0) return;   // 帳號至少有這台：空清單＝沒抓到
    // invalidate 之前就開始的請求可能還有被撤的裝置：照樣更新快取（依開始時間排），但不算 invalidate 後的確認
    apply(startedAt, null, startedAt > invalidatedAt ? generation : 0, keys);
  };
  return check;
}

export interface GoneDeviceTracker {
  /** 一次成功的裝置清單：回傳「確定不在了」的 tracked key（回報後不再追蹤） */
  observe(listed: readonly string[], tracked: Iterable<string>): string[];
}

/**
 * 「確定不在帳號上了」：連續 `misses` 次成功的清單都沒有它，且第一次不在到現在至少 `spanMs`（審查 LOW）。
 * 單一次清單快照偶發少一台時，不能做刪 outbox、移除 peer 這類不可逆的事；中間出現過一次就重新計算。
 * 斷線、不收入站這類可回復的動作照舊立刻做。
 */
export function goneDeviceTracker(options: { misses?: number; spanMs?: number; now?: () => number } = {}): GoneDeviceTracker {
  const misses = options.misses ?? 2;
  const spanMs = options.spanMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  let missing: ReadonlyMap<string, { since: number; count: number }> = new Map();
  return {
    observe(listed, tracked) {
      const at = now();
      const present = new Set(listed);
      const next = new Map<string, { since: number; count: number }>();
      const gone: string[] = [];
      for (const key of new Set(tracked)) {
        if (present.has(key)) continue;
        const previous = missing.get(key);
        const entry = { since: previous?.since ?? at, count: (previous?.count ?? 0) + 1 };
        if (entry.count >= misses && at - entry.since >= spanMs) gone.push(key);
        else next.set(key, entry);
      }
      missing = next;
      return gone;
    },
  };
}

/** 每個帳號一份；換帳號時 accountWipe 依前綴清掉 */
export const SEED_KEY_PREFIX = 'aegistrans_account_device_keys:';
const MAX_SEED_KEYS = 256;
const MAX_SEED_KEY_LENGTH = 256;

function readSeed(storageKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_SEED_KEYS) return null;
    const keys = parsed.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= MAX_SEED_KEY_LENGTH);
    return keys.length === parsed.length ? keys : null;
  } catch {
    return null;
  }
}

/**
 * 上一份成功的裝置清單存在本機（每個帳號一個 aegistrans_ 開頭的 key，只有公鑰）：冷啟動時 API 掛著也認得自己的裝置。
 * PWA（含 Electron renderer）存 localStorage。
 */
export function accountDevicePersistence(userId: string): Pick<AccountDeviceCheckOptions, 'seed' | 'onFetched'> {
  const storageKey = SEED_KEY_PREFIX + userId;
  const seed = readSeed(storageKey);
  let written = seed ? JSON.stringify(seed) : null;
  return {
    seed,
    onFetched: (keys) => {
      const value = JSON.stringify([...keys].sort());
      if (value === written) return;
      try {
        localStorage.setItem(storageKey, value);
        written = value;
      } catch { /* 存不進去（空間滿、被封鎖）：記憶體裡的清單照常可用 */ }
    },
  };
}
