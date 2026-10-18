/**
 * Peer Health Monitor — P2P (WebRTC DataChannel) 健康監控 + 自動重連
 *
 * 跟 mqttHealthMonitor 是「分層」關係,不是各判各的:
 *   - mqttHealthMonitor = 第一層,維持「信令管道 MQTT」活著(死 socket → forceReconnect)。
 *   - peerHealthMonitor = 第二層,**只在 MQTT 確定連線的前提上**才檢查 P2P。
 *
 * 為什麼必須 gate 在 MQTT 上:P2P 重連的 offer / answer / ICE 全靠 MQTT 載;MQTT 沒連上時
 * 不但信令送不出去,連 presence(「對方 online」)都是 stale 不可信的。所以 MQTT 沒好之前
 * 這層完全不動手,交給 mqttHealthMonitor 先把 MQTT 救回來。
 *
 * 治的病:WebRTC 連線可能卡在 connecting / checking(trickle-ICE race),而 webrtc.ts 的
 * state handler 不會自己重連、peerSync 的 presence 重連又只在「離線→上線那一刻」觸發一次
 * → 持續 online 時 P2P 默默死掉就再也沒人救(實測卡死後 22 分鐘不自救)。本 monitor 定時偵測
 * 「presence 認為 online、但 DataChannel 沒 open 超過寬限期」→ 重連。
 *
 * log 一律用 console.error(Vite production build 會剝掉 console.log/warn,只留 error)。
 */

import { mqttService } from './mqtt';

const PROBE_INTERVAL_FG = 10_000;  // 前景 10s
const PROBE_INTERVAL_BG = 30_000;  // 背景 30s
// DataChannel 沒 open 超過此時間才算「卡住」要重連。正常握手 <1s 就 open(實測 0.3s),
// 留 15s 寬限 → 絕不會打斷正在交握中的連線。
const STUCK_GRACE_MS = 15_000;

export interface PeerHealthDeps {
  /** 目前 presence 認為 online 的 known peers。 */
  getOnlineKnownPeers: () => string[];
  /** 該 peer 的 DataChannel 是否真的 open。 */
  isPeerHealthy: (pk: string) => boolean;
  /** 卡住 → 重連(內含 initiator tiebreak,避免兩台同時重連造成 glare 風暴)。 */
  reconnectPeer: (pk: string) => void;
}

class PeerHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isForeground = true;
  private deps: PeerHealthDeps | null = null;
  // 每個 peer「第一次被觀察到不健康」的時間戳,用來算寬限期。
  private stuckSince = new Map<string, number>();

  start(deps: PeerHealthDeps): void {
    this.deps = deps;
    if (this.timer) return; // 已在運行
    console.error('[PeerHealth] Starting');
    this.stuckSince.clear();
    this._schedule();
  }

  stop(): void {
    console.error('[PeerHealth] Stopping');
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.stuckSince.clear();
    this.deps = null;
  }

  onVisibilityChange(isForeground: boolean): void {
    this.isForeground = isForeground;
    this._schedule();
    if (isForeground) this._probe();
  }

  onNetworkChange(isOnline: boolean): void {
    // 網路恢復 → 立即檢查(MQTT 可能也剛回來,gate 沒過就會自己 return)
    if (isOnline) this._probe();
  }

  /** 外部立即觸發 — 例:MQTT 剛(重)連上,P2P 很可能也跟著死了,馬上補一次檢查。 */
  probeNow(): void { this._probe(); }

  private _schedule(): void {
    if (this.timer) clearInterval(this.timer);
    if (!this.deps) return;
    const interval = this.isForeground ? PROBE_INTERVAL_FG : PROBE_INTERVAL_BG;
    this.timer = setInterval(() => this._probe(), interval);
  }

  private _probe(): void {
    const deps = this.deps;
    if (!deps) return;

    // ① MQTT gate — P2P 健康不能自己獨立判斷,必須先確定 MQTT 真的連著。
    //    沒連 → 信令送不出去 + presence stale → 這拍什麼都不做,等 mqttHealthMonitor 救 MQTT。
    if (!mqttService.isConnected()) return;

    // ② MQTT 確定連著,才評估 P2P。
    const online = deps.getOnlineKnownPeers();
    const onlineSet = new Set(online);

    // 已離線的 peer → 清掉它的卡住計時(下次上線重新算)
    for (const pk of [...this.stuckSince.keys()]) {
      if (!onlineSet.has(pk)) this.stuckSince.delete(pk);
    }

    const now = Date.now();
    for (const pk of online) {
      if (deps.isPeerHealthy(pk)) {
        this.stuckSince.delete(pk);
        continue;
      }
      const since = this.stuckSince.get(pk);
      if (since === undefined) {
        this.stuckSince.set(pk, now); // 第一次觀察到不健康 → 開始計寬限
        continue;
      }
      if (now - since >= STUCK_GRACE_MS) {
        console.error(`[PeerHealth] Stuck peer (no open DataChannel ${Math.round((now - since) / 1000)}s) → reconnect: ${pk.slice(0, 8)}`);
        deps.reconnectPeer(pk);
        this.stuckSince.delete(pk); // 重置:下一拍給新連線重新算寬限,避免狂重連
      }
    }
  }
}

export const peerHealthMonitor = new PeerHealthMonitor();
