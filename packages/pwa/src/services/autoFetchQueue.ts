/**
 * 全域自動接收佇列（並行度 1）。
 *
 * 問題：Timeline 每個待接收的媒體 bubble 各有自己的 auto-fetch effect。歷史列表若同時有多個
 * ≤200MB 的圖/影片/音訊，會各自同時發起 fetchFile → 可能一次並行下載接近 1GB：吃爆行動數據、
 * IndexedDB 空間、同時堆多組 chunk/hash receiver state，手機記憶體壓力甚至被系統終止。
 * 單檔 storage precheck 也擋不住「多個 precheck 同時通過後共同耗盡空間」。
 *
 * 解法：所有「自動」接收排進這條全域序列佇列，一次只跑 1 個。序列化後，每個工作的 storage
 * precheck 都在前一個下載完成之後才跑 → 看到的是更新後的剩餘空間 → 天然的累計 reservation，
 * 不會多檔同時放行。使用者「手動」點下載不受此限（主動操作、一次一個）。
 *
 * ponytail: 單一序列 queue、並行度 1；夠用就好，未來要更高吞吐再把 CONCURRENCY 調大。
 */

const queue: Array<() => Promise<void>> = [];
const enqueuedIds = new Set<string>(); // 去重：同 fileId 只自動排一次（元件 remount 會重觸發 effect）
let active = 0;
const CONCURRENCY = 1; // ponytail: 自動下載並行上限；1 = 完全序列，最省資源

async function drain(): Promise<void> {
  if (active >= CONCURRENCY) return;
  const job = queue.shift();
  if (!job) return;
  active++;
  try {
    await job();
  } catch {
    // job 內部應自行處理錯誤（顯示 toast 等）；這裡吞掉避免卡住佇列。
  } finally {
    active--;
    void drain();
  }
}

/**
 * 把一個自動接收工作排進全域序列佇列（並行度 1）。
 * job 必須 await 到「該檔真的收完/失敗」才 resolve（見 fileTransfer.waitForFileComplete），
 * 否則並行度 1 只序列化了送請求、沒序列化實際傳輸。以 fileId 去重，避免重複排入同一檔。
 */
export function enqueueAutoFetch(fileId: string, job: () => Promise<void>): void {
  if (enqueuedIds.has(fileId)) return; // 已排過（含完成/失敗）→ 不重複自動下載；手動下載不受此限
  enqueuedIds.add(fileId);
  queue.push(job);
  void drain();
}

/** 目前佇列長度（含執行中）— 測試/診斷用。 */
export function autoFetchPending(): number {
  return queue.length + active;
}
