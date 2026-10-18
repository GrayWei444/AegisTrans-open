/**
 * MQTT Service - WebSocket 信令連線
 *
 * 透過 MQTT over WebSocket 進行信令交換
 * 用於 WebRTC 連線建立、PreKeyBundle 交換等
 *
 * E2EE Phase 2 改善：
 * - Sealed Sender：隱藏發送者身份，MQTT Broker 無法追蹤通訊模式
 */

import mqtt, { MqttClient, IClientOptions, type MqttClientEventCallbacks } from 'mqtt';
// AegisTrans: sealedSender (anonymous sender E2EE) deprecated — 自己對自己不需要隱藏寄件者身份。
// 留下寬型 stub 讓既有 mqtt 收件流程編譯通過，B-3 重寫 messaging 時整段移除。
type SealedEnvelope = { ciphertext: string; ephemeralPublicKey?: string };
type UnsealResult = {
  from: string;
  type: string;
  payload: unknown;
  timestamp: number;
  signature: string;
};
async function unsealMessageBase64(_data: unknown, _key: unknown): Promise<UnsealResult> {
  return { from: '', type: '', payload: null, timestamp: 0, signature: '' };
}
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';
import { getDeviceIdSync } from './deviceId';
import { apiBase } from './apiBase';
import { getActiveServer } from './serverChoice';

/**
 * 將 Base64 轉換為 URL 安全格式（用於 MQTT 主題）
 * Base64 的 + 和 / 在 MQTT 中是特殊字符
 */
function toUrlSafeBase64(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// MQTT 設定
const MQTT_CONFIG = {
  // 正式 broker 由目前選的伺服器決定（serverChoice：預設官方，使用者可改成自己的）。
  //   官方是 AegisTrans 專屬「鎖死(default-deny + per-account acl)」EMQX broker(C-1);token acl 只准碰自己帳號。
  // 開發環境 (本地 EMQX)
  devBroker: 'ws://localhost:8083/mqtt',
  // 停用 mqtt.js 內建重連 — 由 MqttHealthMonitor 控制重連生命週期
  // 原因：OS 殺 socket 後 mqtt.js 重連用同一個 client 實例 → EMQX 不回 CONNACK → 死鎖
  reconnectPeriod: 0,
  connectTimeout: 15000,
  // 從 60s 降到 30s — 更快偵測死連線
  keepalive: 30,
};

// presence staleness 門檻：online peer 每 30s republish 一次 presence 心跳。
// 用 5 次(150s)而非 3 次(90s)當門檻 —— 90s 太緊，網路抖動 / 對端短暫重連(其間
// heartbeat timer 被 _teardown 停掉)/ QoS-1 redelivery 都可能讓「真的在線」的 peer
// 超過 90s 沒消息 → 誤判離線 flap。150s 給足容錯。
const PRESENCE_STALE_MS = 150_000;

// 訊息類型
export enum MessageType {
  // 金鑰交換
  PRE_KEY_BUNDLE = 'prekey_bundle',
  PREKEY_REQUEST = 'prekey_request',
  X3DH_INIT = 'x3dh_init',
  // 邀請系統
  INVITE_ACCEPT = 'invite_accept',
  // WebRTC 信令
  WEBRTC_OFFER = 'webrtc_offer',
  WEBRTC_ANSWER = 'webrtc_answer',
  WEBRTC_ICE = 'webrtc_ice',
  // 加密訊息
  ENCRYPTED_MESSAGE = 'encrypted_message',
  // 訊息控制
  DELETE_MESSAGE = 'delete_message', // 遠端刪除訊息
  // 語音通話
  CALL_REQUEST = 'call_request',   // 發起通話請求
  CALL_ACCEPT = 'call_accept',     // 接受通話
  CALL_REJECT = 'call_reject',     // 拒絕通話
  CALL_END = 'call_end',           // 結束通話
  // 語音通話專用 WebRTC 信令（與資料通道分開，避免衝突）
  CALL_WEBRTC_OFFER = 'call_webrtc_offer',
  CALL_WEBRTC_ANSWER = 'call_webrtc_answer',
  CALL_WEBRTC_ICE = 'call_webrtc_ice',
  // 個人資料同步
  PROFILE_UPDATE = 'profile_update', // 個人資料更新（頭像、名稱）
  PROFILE_REQUEST = 'profile_request', // 請求對方的個人資料
  PUSH_SUBSCRIPTION_UPDATE = 'push_subscription_update', // 推播訂閱更新
  // 註:Shamir 社交恢復(SHARD_*/RECOVERY_*/BACKUP_*)已移除 —— AegisTrans 不做社交恢復
  //    (見 CLAUDE.md 教訓 1),fork 時的死碼於 2026-06 清掉(AegisTalk 也已移除)。
  // Phase 8: 換機傳輸（場景 2）
  DEVICE_TRANSFER_REQUEST = 'device_transfer_request',  // 新設備請求傳輸
  DEVICE_TRANSFER_DATA = 'device_transfer_data',        // 舊設備回傳資料
  // Phase 9: 群組聊天（Phase 32: GROUP_MESSAGE / GROUP_FILE 已移除 — 走 P2P encrypted_message）
  GROUP_INVITE = 'group_invite',                 // 群組邀請
  GROUP_MEMBER_ADDED = 'group_member_added',     // 成員加入
  GROUP_MEMBER_REMOVED = 'group_member_removed', // 成員移除
  GROUP_MEMBER_LEFT = 'group_member_left',       // 成員離開
  GROUP_INFO_UPDATED = 'group_info_updated',     // 群組資訊更新
  GROUP_ROLE_UPDATED = 'group_role_updated',     // 成員角色更新
  // Phase 10: 多人群組通話
  GROUP_CALL_START = 'group_call_start',         // 發起群組通話
  GROUP_CALL_JOIN = 'group_call_join',           // 加入群組通話
  GROUP_CALL_LEAVE = 'group_call_leave',         // 離開群組通話
  GROUP_CALL_END = 'group_call_end',             // 結束群組通話（全部）
  GROUP_CALL_OFFER = 'group_call_offer',         // 群組通話 WebRTC Offer
  GROUP_CALL_ANSWER = 'group_call_answer',       // 群組通話 WebRTC Answer
  GROUP_CALL_ICE = 'group_call_ice',             // 群組通話 ICE Candidate
  // Phase 19.6: 原生報平安提醒
  CHECK_IN_REMINDER = 'check_in_reminder',
  // Phase 2 (AegisTrans 跨裝置螢幕延伸 + 鏡像)：媒體 renegotiation 信令
  // 既有 PeerConnection 已建立後，加 video track → 重新 offer/answer 走這三條，
  // 跟 file DataChannel 的 WEBRTC_OFFER/ANSWER 區分（接收端據此 wire 到 mediaChannel）。
  SCREEN_SHARE_OFFER = 'screen_share_offer',
  SCREEN_SHARE_ANSWER = 'screen_share_answer',
  SCREEN_SHARE_END = 'screen_share_end',
  // Receiver 拒絕：sender 收到此訊息要 detachLocalStream + 回收
  SCREEN_SHARE_REJECT = 'screen_share_reject',
  // 行動端原生發送(iOS Broadcast Extension / Android MediaProjection)用：原生 sender 的
  // 螢幕 video 走「獨立專用 PeerConnection」(非既有 file PC),所以需要全新 trickle ICE 交換。
  // 既有 SCREEN_SHARE_OFFER/ANSWER 在已連線的 file PC 上 renegotiate 不需 ICE;dedicated 路徑才用此。
  // payload: RTCIceCandidateInit ({ candidate, sdpMid, sdpMLineIndex })
  SCREEN_SHARE_ICE = 'screen_share_ice',
  // 控制訊息
  PRESENCE = 'presence',
  TYPING = 'typing',
}

// 推播資料結構（用於離線推播）
interface PushData {
  subscription: {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
  notification: {
    type: 'message' | 'call' | 'friend_request' | 'group_invite';
    title: string;
    body: string;
    data?: Record<string, unknown>;
  };
}

// 訊息結構
export interface MqttMessage {
  type: MessageType;
  from: string; // 發送者公鑰 (Base64)
  to?: string; // 接收者公鑰 (Base64)，廣播時為空
  payload: unknown;
  timestamp: number;
  signature?: string; // 訊息簽章
  pushData?: PushData; // 離線推播資料（接收方的訂閱資訊）
  notificationHint?: NotificationHint; // 原文通知提示（供原生服務顯示通知）
}

// 通知提示（不含敏感內容，供 Android GuardianMqttService / AegisFCMService 解析顯示通知）
export interface NotificationHint {
  type: 'guardian_alert' | 'check_in' | 'message' | 'incoming_call';
  alertType?: string;
  protectedName?: string;
  checkInType?: string;
  // Phase 20: 發送者名稱 + 來電資訊
  senderName?: string;
  isVideoCall?: boolean;
}

// 連線狀態
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

// 事件回調
type MessageCallback = (message: MqttMessage) => void;
type StateCallback = (state: ConnectionState) => void;
type PresenceCallback = (publicKey: string, isOnline: boolean) => void;
type SealedMessageCallback = (result: UnsealResult) => void;

// Sealed Sender 訊息包裝（MQTT 層）
interface SealedMqttMessage {
  sealed: true;
  envelope: SealedEnvelope;
  timestamp: number;
}

// 離線待發訊息
interface OutgoingMessage {
  topic: string;
  payload: string;
  qos: 0 | 1 | 2;
  timestamp: number;
}

// Health Monitor 用的健康資訊
interface MqttHealthInfo {
  state: ConnectionState;
  wsReadyState: number | null; // WebSocket.readyState (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)
  lastMessageReceivedAt: number; // Date.now() timestamp
  clientConnected: boolean;
  publicKey: string | null;
  tokenFailed: boolean; // token 取得失敗（403），cooldown 中不重試
  hasPinHash: boolean;  // PIN hash 存在 = 認證完成，可嘗試連線
}

/**
 * MQTT 服務類別
 */
class MqttService {
  private client: MqttClient | null = null;
  private publicKeyBase64: string | null = null;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private connectingPromise: Promise<void> | null = null; // Guard against concurrent connects
  /** 還沒連上的那次連線的「放棄」：_teardown 拆掉它時讓它的 promise reject */
  private _abortConnect: ((error: Error) => void) | null = null;
  /** 換 token 的換連線（好好斷線 → 用新 token 連上），進行中才有 */
  private _swap: Promise<void> | null = null;

  // 事件監聯器
  private messageListeners: Map<MessageType, Set<MessageCallback>> = new Map();
  private stateListeners: Set<StateCallback> = new Set();

  // 訊息緩衝：MQTT 重連後 broker 立即送出暫存訊息，但 React useEffect 尚未註冊 listener，
  // 導致 X3DH_INIT 等關鍵訊息被丟棄。此緩衝暫存無 listener 的訊息，等 listener 註冊時重播。
  private pendingMessages: Map<string, MqttMessage[]> = new Map();
  private pendingMessageTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Phase 5: Presence 追蹤
  private presenceListeners: Set<PresenceCallback> = new Set();
  private friendPresence: Map<string, boolean> = new Map(); // publicKey -> isOnline
  private subscribedPresenceTopics: Set<string> = new Set();
  // 每個 peer 最後一次「有收到任何訊息/presence 心跳」的時間。online peer 每 30s
  // republish presence(startPresenceHeartbeat),所以超過 PRESENCE_STALE_MS 沒消息 =
  // 對方真的不見了 → staleness sweep 標 offline。修「對端死掉/從未連上卻一直顯示 online」
  // (LWT 在對端從未連上 broker 時根本不會 fire;keepalive race 也可能留 stale retained=true)。
  private friendLastSeen: Map<string, number> = new Map(); // publicKey -> last activity ms

  // E2EE Phase 2: Sealed Sender
  private privateKeyBase64: string | null = null; // 用於解封訊息
  private sealedMessageListeners: Set<SealedMessageCallback> = new Set();

  // Health Monitor 追蹤
  private _lastMessageReceivedAt = 0; // 最後收到訊息的時間戳
  private _isDev = false; // 記住 isDev 供 forceReconnect 使用

  // 離線訊息緩衝：MQTT 斷線時暫存待發訊息，重連後自動 flush
  private outgoingQueue: OutgoingMessage[] = [];
  private static readonly MAX_OUTGOING_QUEUE = 200; // 最多緩衝 200 條

  // JWT 認證 token 快取
  private _mqttToken: string | null = null;
  private _mqttTokenExpiresAt = 0;
  /** 到期前換 token 的計時器（稽核 B21） */
  private _tokenRenewTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly TOKEN_RENEW_BEFORE_MS = 120_000;
  private static readonly TOKEN_RENEW_RETRY_MS = 30_000;
  private static readonly MIN_TOKEN_LIFETIME_MS = 10 * 60_000;
  // C-1：帳號 id，用來把 per-device topic 命名空間化成 mist/acct/{userId}/user/{safeKey}/...
  // 好讓 broker ACL 用單一 wildcard `mist/acct/{userId}/#` 覆蓋整帳號所有裝置（不用逐裝置列舉，
  // 上新裝置也不會讓舊裝置的 token ACL 過期失效）。dev broker 無此需求 → null 時 fallback 舊 scheme。
  private accountUserId: string | null = null;
  private _tokenFetchFailedAt = 0; // 最後一次 token 取得失敗的時間
  private static readonly TOKEN_RETRY_COOLDOWN = 60_000; // 60s cooldown after 403
  /** 4c281d0 之前訂的全域 topic（帳號命名空間之前；正式版 cc682d7 還在訂） */
  private static readonly LEGACY_GLOBAL_TOPICS = ['mist/broadcast'];

  /**
   * 取得主題設定
   */
  private getTopics(): { inbox: string; broadcast: string; group: (groupId: string) => string; presence: (publicKey: string) => string } {
    if (!this.publicKeyBase64) {
      throw new Error('Not connected');
    }
    // 使用 URL 安全的 Base64 作為主題名稱
    const safeKey = toUrlSafeBase64(this.publicKeyBase64);
    return {
      inbox: this.userTopic(safeKey, 'inbox'),
      // 稽核 B2：帳號已知時廣播頻道放在帳號底下。以前全帳號共用 mist/broadcast（ACL 也准每個帳號讀寫），
      //   任何帳號都能對所有在線 client 注入任何 MessageType；只有沒有帳號的 dev broker 才用舊名稱。
      broadcast: this.accountUserId ? `mist/acct/${this.accountUserId}/broadcast` : 'mist/broadcast',
      group: (groupId: string) => `mist/group/${groupId}`,
      // Phase 5: 好友 presence 主題（自對自：對方即同帳號 sibling 裝置 → 同 userId 命名空間）
      presence: (publicKey: string) => this.userTopic(toUrlSafeBase64(publicKey), 'presence'),
    };
  }

  /**
   * C-1：per-device topic。帳號已知 → mist/acct/{userId}/user/{safeKey}/{leaf}
   * （ACL 用 mist/acct/{userId}/# 一條覆蓋，不逐裝置列舉，避免上新裝置後舊 token ACL 過期）；
   * dev broker（無 userId）→ fallback 舊 scheme mist/user/{safeKey}/{leaf}。
   */
  private userTopic(safeKey: string, leaf: string): string {
    return this.accountUserId
      ? `mist/acct/${this.accountUserId}/user/${safeKey}/${leaf}`
      : `mist/user/${safeKey}/${leaf}`;
  }

  /**
   * 帳號層「裝置名冊」公告 topic（與 pubkey 無關）。新裝置加入時往這裡發 ping，
   * 同帳號所有裝置都訂它 → 立即重抓 listDevices → 秒收斂看到新裝置。
   * presence 是綁 pubkey 的（要先知道對方 pubkey 才訂得到），無法用來「發現」新裝置；
   * 這條與身分無關的公告頻道補上那個缺口。null = dev broker（無 userId）不啟用。
   */
  private rosterTopic(): string | null {
    return this.accountUserId ? `mist/acct/${this.accountUserId}/devices` : null;
  }

  /** 這台的 kick 通道（ACL 給 aegis/device/+/kicked 的 sub 權限；id 是 aegis_device_id）；還沒有 id 時沒有 */
  private kickTopic(): string | null {
    const deviceId = (typeof localStorage !== 'undefined' && localStorage.getItem('aegis_device_id')) || '';
    return deviceId ? `aegis/device/${deviceId}/kicked` : null;
  }

  /**
   * 這台該收的 topic：帳號自己的命名空間、我的裝置群組、這台的 kick 通道。clientId 固定＋clean:false 的 session 會把舊版
   * 留下的訂閱（4c281d0 之前的全域 `mist/broadcast`、帳號命名空間之前的 mist/user/…）原樣還原，那些 topic 上偽造 `from`
   * 的訊息不能分派（AegisTrans 審查 A；對應 TofuTalk 21da0cc）。沒有帳號的 dev broker 用舊 scheme，照舊全收。
   */
  private isOwnTopic(topic: string): boolean {
    const uid = this.accountUserId;
    if (!uid) return true;
    return topic.startsWith(`mist/acct/${uid}/`)
      || topic === `mist/group/aegistrans:${uid}:my-devices`
      || topic === this.kickTopic();
  }

  private rosterListeners = new Set<() => void>();

  /** 訂閱「有新裝置加入/名冊變動」事件；回傳 unsubscribe。上層收到後應重抓裝置清單。 */
  onRosterChanged(cb: () => void): () => void {
    this.rosterListeners.add(cb);
    return () => this.rosterListeners.delete(cb);
  }

  /** 撤銷裝置後呼叫：讓其他裝置立刻重抓清單，被撤的那台不再靠清單快取過關（稽核 B1） */
  announceRosterChange(): void {
    this.publishRosterPing();
  }

  /** 向同帳號其他裝置公告「我在這/名冊變了」，觸發它們立即重抓清單。 */
  private publishRosterPing(): void {
    const t = this.rosterTopic();
    if (!t || !this.client?.connected) return;
    this.client.publish(
      t,
      JSON.stringify({ type: 'roster_ping', from: this.publicKeyBase64, at: Date.now() }),
      { qos: 1 },
    );
  }

  /**
   * Phase 5: 取得自己的 presence 主題
   */
  private getMyPresenceTopic(): string {
    if (!this.publicKeyBase64) {
      throw new Error('Not connected');
    }
    const safeKey = toUrlSafeBase64(this.publicKeyBase64);
    return this.userTopic(safeKey, 'presence');
  }

  /**
   * 取得 MQTT JWT token（帶快取，提前 5 分鐘刷新）
   */
  private async _fetchMqttToken(publicKeyBase64: string): Promise<string | null> {
    // 前置條件：PIN 未設定 → pubkeyHash 未註冊 VPS → 不嘗試（避免 403）
    // 先查 localStorage，再 fallback 到 SQLite（PIN hash 可能只存在 DB 中）
    let hasPinHash = !!localStorage.getItem('mist_pin_hash');
    if (!hasPinHash) {
      try {
        const { getSetting } = await import('./database');
        const dbHash = await getSetting('mist_pin_hash');
        if (dbHash) {
          // 回寫到 localStorage 以便後續快速查詢
          localStorage.setItem('mist_pin_hash', dbHash);
          hasPinHash = true;
        }
      } catch {
        // database 未初始化時忽略
      }
    }
    // PIN setup (Argon2id) 在背景執行，mist_pin_hash 寫入 localStorage 有延遲
    // 等待最多 30 秒讓 PIN setup 完成（含 SQLite fallback）
    if (!hasPinHash) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (localStorage.getItem('mist_pin_hash')) {
          hasPinHash = true;
          console.error(`[MQTT] mist_pin_hash appeared in localStorage after ${i + 1}s`);
          break;
        }
        // 每 5 秒也查 SQLite（PIN hash 可能只寫到 DB）
        if (i % 5 === 4) {
          try {
            const { getSetting } = await import('./database');
            const dbHash = await getSetting('mist_pin_hash');
            if (dbHash) {
              localStorage.setItem('mist_pin_hash', dbHash);
              hasPinHash = true;
              console.error(`[MQTT] mist_pin_hash found in SQLite after ${i + 1}s`);
              break;
            }
          } catch { /* database not ready */ }
        }
      }
    }
    if (!hasPinHash) {
      console.error('[MQTT] _fetchMqttToken: no mist_pin_hash after 15s wait, aborting');
      return null;
    }

    // 使用快取中的 token（提前 5 分鐘刷新）
    if (this._mqttToken && this._mqttTokenExpiresAt > Date.now() + 300_000) {
      return this._mqttToken;
    }

    // Cooldown: 上次 token 取得失敗後 60 秒內不重試（防止 403 spam）
    if (this._tokenFetchFailedAt > 0 &&
        Date.now() - this._tokenFetchFailedAt < MqttService.TOKEN_RETRY_COOLDOWN) {
      return null;
    }

    // AegisTrans: 改打自家同源 endpoint，免 CORS
    try {
      // 計算 pubkeyHash：使用 URL-safe base64（與伺服器端 pubkey_hash 一致）
      const safeKey = toUrlSafeBase64(publicKeyBase64);
      const encoder = new TextEncoder();
      const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(safeKey));
      const hashArr = new Uint8Array(hashBuf);
      const pubkeyHash = Array.from(hashArr).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

      // user JWT 從 localStorage 取（aegistrans_session）
      const sessionRaw = localStorage.getItem('aegistrans_session');
      const userJwt = sessionRaw ? (() => { try { return JSON.parse(sessionRaw).jwt as string; } catch { return null; } })() : null;
      if (!userJwt) {
        console.error('[MQTT] No user JWT in session, cannot fetch MQTT token');
        this._tokenFetchFailedAt = Date.now();
        return null;
      }

      // C-3：MQTT token 必須綁裝置 — server 會驗證 (user_id, device_id) 還在 aegistrans_devices。
      // 撤銷裝置後，此 device_id 不存在 → 403，broker 端 1 小時內現有 token 過期後就斷。
      //
      // 等待 aegistrans_device_id 出現（device 註冊完成後才會寫入 localStorage；
      // 跟 mist_pin_hash 一樣有 race window）。最多等 15 秒，沒拿到就 abort（下次 retry）。
      let aegistransDeviceId = (typeof localStorage !== 'undefined')
        ? localStorage.getItem('aegistrans_device_id')
        : null;
      if (!aegistransDeviceId) {
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          aegistransDeviceId = localStorage.getItem('aegistrans_device_id');
          if (aegistransDeviceId) {
            console.error(`[MQTT] aegistrans_device_id appeared after ${i + 1}s`);
            break;
          }
        }
      }
      if (!aegistransDeviceId) {
        console.error('[MQTT] _fetchMqttToken: no aegistrans_device_id after 15s, aborting (will retry)');
        this._tokenFetchFailedAt = Date.now();
        return null;
      }
      const response = await fetch(`${apiBase()}/aegistrans/auth/mqtt/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${userJwt}`,
        },
        body: JSON.stringify({ pubkeyHash, device_id: aegistransDeviceId }),
      });

      if (!response.ok) {
        console.error(`[MQTT] Token fetch failed: HTTP ${response.status}`);
        this._tokenFetchFailedAt = Date.now();
        return null;
      }

      const data = await response.json() as { token: string; expiresAt: number };
      const receivedAt = Date.now();
      this._mqttToken = data.token;
      // 本機時鐘上的到期時間＝收到時間＋效期（對應 TofuTalk fc6910d：直接拿 exp 比本機時鐘，時鐘快的裝置會一直以為快到期）
      this._mqttTokenExpiresAt = receivedAt + MqttService.tokenLifetimeMs(data.token, data.expiresAt, receivedAt);
      this._tokenFetchFailedAt = 0; // 重置失敗記錄
      devLog('[MQTT] JWT token acquired, expires:', new Date(this._mqttTokenExpiresAt).toISOString());
      return data.token;
    } catch (err) {
      console.error('[MQTT] Failed to fetch MQTT token:', err);
      this._tokenFetchFailedAt = Date.now();
      return null;
    }
  }

  /**
   * 連線到 MQTT Broker
   *
   * Guards against concurrent connect() calls and properly cleans up
   * any existing client before creating a new one, preventing zombie connections.
   */
  async connect(publicKeyBase64: string, isDev = false, userId?: string): Promise<void> {
    // C-1：帳號 id 用來命名空間化 per-device topic。只在有傳入時覆寫，
    // 讓 health-monitor 的無 userId reconnect 仍沿用先前設定的值。
    if (userId) this.accountUserId = userId;
    // Guard: if already connected with the same key, skip — but first correct any
    // state desync. socket 可能自己從短暫 offline/close 復原（client.connected===true）卻
    // 把 this.state 留在 RECONNECTING/DISCONNECTED → React isConnected 卡 false →
    // AppProvider「已連線」分支(session repair / presence / P2P 就緒)永遠不跑 → 兩邊傳不動。
    // port 自 AegisTalk mqtt.ts（第零守則）。
    if (this.client?.connected && this.publicKeyBase64 === publicKeyBase64) {
      if (this.state !== ConnectionState.CONNECTED) {
        this.setState(ConnectionState.CONNECTED);
      }
      console.error('[MQTT] Already connected, skipping');
      return;
    }

    // Guard: if a connect is already in progress, return the same promise
    if (this.connectingPromise) {
      console.error('[MQTT] Connect already in progress, waiting...');
      return this.connectingPromise;
    }
    return this._open(publicKeyBase64, isDev, null);
  }

  /**
   * 開一條新連線。`owner`：佔著 connectingPromise 的那次換連線（換 token 時，_swapConnection）；一般 connect 是 null。
   */
  private async _open(publicKeyBase64: string, isDev: boolean, owner: Promise<void> | null): Promise<void> {
    // Guard: if client exists but not disconnected (e.g. still closing), tear it down first
    if (this.client && !this.client.disconnected && this.publicKeyBase64 === publicKeyBase64) {
      devWarn('[MQTT] Client exists in limbo state, tearing down first');
      this._teardown();
    }

    // Early check: if token is in cooldown, don't even start (prevents CONNECTING→DISCONNECTED churn)
    if (!isDev && this._tokenFetchFailedAt > 0 &&
        Date.now() - this._tokenFetchFailedAt < MqttService.TOKEN_RETRY_COOLDOWN) {
      console.error('[MQTT] Token in cooldown, skipping connect. Remaining:', Math.round((MqttService.TOKEN_RETRY_COOLDOWN - (Date.now() - this._tokenFetchFailedAt)) / 1000) + 's');
      return;
    }

    const broker = isDev ? MQTT_CONFIG.devBroker : getActiveServer().mqttUrl;
    if (!broker) {
      // 自架 build 沒設 VITE_DEFAULT_MQTT_URL：連不了，也不要把空字串交給 mqtt.js
      console.error('[MQTT] No broker URL configured for the selected server');
      return;
    }

    // Clean up any existing client BEFORE creating a new one
    if (this.client) {
      devWarn('[MQTT] Cleaning up previous client before reconnect');
      this._teardown();
    }

    this.publicKeyBase64 = publicKeyBase64;
    this._isDev = isDev;
    this.setState(ConnectionState.CONNECTING);

    // Phase 5: 準備 Last Will Testament (LWT) - 離線時自動發布
    const safeKey = toUrlSafeBase64(publicKeyBase64);
    const presenceTopic = this.userTopic(safeKey, 'presence');
    const offlineMessage = JSON.stringify({
      type: MessageType.PRESENCE,
      from: publicKeyBase64,
      payload: { online: false },
      timestamp: Date.now(),
    });

    // JWT 認證：取得 token 作為 MQTT password
    const jwtToken = isDev ? null : await this._fetchMqttToken(publicKeyBase64);

    // 等 token 的時候別處已經開始連（health monitor 的 forceReconnect、另一個 connect、換連線）：跟著它，不再開第二條
    // （AegisTrans 審查 B：以前兩條都建，先建的那條沒人管）
    if (this.connectingPromise && this.connectingPromise !== owner) return this.connectingPromise;

    // If token fetch failed in production, don't attempt connection (EMQX will reject)
    if (!isDev && !jwtToken) {
      console.error('[MQTT] No JWT token, aborting connect. tokenFailed:', this._tokenFetchFailedAt > 0, 'pinHash:', !!localStorage.getItem('mist_pin_hash'));
      this.setState(ConnectionState.DISCONNECTED);
      return;
    }

    const options: IClientOptions = {
      // Phase 1 收尾：clientId 含 fingerprint-derived deviceId（前 16 hex = 64 bits）。
      // 同硬體不同瀏覽器 → 同 deviceId → 同 clientId → EMQX 自動踢舊 session。
      // 不同硬體 → 不同 deviceId → 多裝置正常並存。
      clientId: `mist_${safeKey.slice(0, 16)}_${(getDeviceIdSync() ?? 'default').slice(0, 16)}`,
      clean: false,
      reconnectPeriod: MQTT_CONFIG.reconnectPeriod,
      connectTimeout: MQTT_CONFIG.connectTimeout,
      keepalive: MQTT_CONFIG.keepalive,
      // 使用公鑰作為 username，JWT 作為 password
      username: publicKeyBase64,
      password: jwtToken ?? undefined,
      // 協定版本
      protocolVersion: 5,
      // MQTT 5.0: 持久 session，離線時 broker 暫存 QoS 1 訊息（24 小時）
      // 確保好友邀請、加密訊息等在對方離線期間不會丟失
      properties: {
        sessionExpiryInterval: 86_400,
      },
      // Phase 5: Last Will Testament - 離線時自動發布
      will: {
        topic: presenceTopic,
        payload: offlineMessage, // MQTT.js 會自動處理字串轉換
        qos: 1,
        retain: true,
      },
    };

    let abort: ((error: Error) => void) | null = null;
    const attempt: Promise<void> = new Promise<void>((resolve, reject) => {
      devLog(`[MQTT] Connecting to ${broker}...`);
      const client = mqtt.connect(broker, options);
      this.client = client;
      let settled = false;
      // 這條連線還沒連上就被 _teardown 拆掉（登出、重連、換連線）：reject，等它的人（health monitor）不會永遠等下去
      abort = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      this._abortConnect = abort;

      this._listen(client, 'connect', () => {
        devLog('[MQTT] Connected OK');
        this._lastMessageReceivedAt = Date.now();
        this.setState(ConnectionState.CONNECTED);
        this.subscribeToDefaultTopics();
        this._flushOutgoingQueue();
        this._scheduleTokenRenewal();
        if (!settled) { settled = true; resolve(); }
      });

      this._listen(client, 'reconnect', () => {
        devWarn('[MQTT] Reconnecting...');
        this.setState(ConnectionState.RECONNECTING);
      });

      this._listen(client, 'close', () => {
        devWarn('[MQTT] Connection closed');
        this.setState(ConnectionState.DISCONNECTED);
      });

      // MQTT 5.0: server-initiated disconnect with reason code
      this._listen(client, 'disconnect', (packet: { reasonCode?: number; properties?: { reasonString?: string } }) => {
        devWarn(`[MQTT] Disconnect from server: code=${packet?.reasonCode}, reason=${packet?.properties?.reasonString || 'none'}`);
      });

      this._listen(client, 'offline', () => {
        devWarn('[MQTT] Client went offline');
      });

      // 追蹤所有收到的封包（包括 PINGRESP）來偵測連線存活
      // mqtt.js 的 PINGREQ/PINGRESP 不會觸發 'message' 事件
      this._listen(client, 'packetreceive', () => {
        this._lastMessageReceivedAt = Date.now();
      });

      this._listen(client, 'error', (error) => {
        // Must use console.error (not devWarn) — devWarn is stripped in release,
        // causing mqtt.js errors to become Uncaught Errors
        console.error('[MQTT] Error:', error?.message || error);
        this.setState(ConnectionState.ERROR);
        // Only reject the initial connect promise, not reconnect errors
        if (!settled) { settled = true; reject(error); }
      });

      this._listen(client, 'message', (topic, payload) => {
        this._lastMessageReceivedAt = Date.now();
        this.handleMessage(topic, payload);
      });

      // 連線超時
      setTimeout(() => {
        if (!settled && this.state === ConnectionState.CONNECTING) {
          settled = true;
          reject(new Error('Connection timeout'));
        }
      }, MQTT_CONFIG.connectTimeout);
    }).finally(() => {
      if (this.connectingPromise === attempt) this.connectingPromise = null;
      if (this._abortConnect === abort) this._abortConnect = null;
    });
    this.connectingPromise = attempt;
    return attempt;
  }

  /**
   * 斷開連線（用戶主動斷開，清除 publicKey）
   */
  disconnect(): void {
    if (this.client || this._swap) {   // 換連線中舊 client 已拔掉：照樣停（換連線看到 publicKey 沒了就不再連）
      devLog('[MQTT] Disconnecting (user-initiated)');
      this._teardown();
      this.publicKeyBase64 = null;
    }
  }

  /**
   * Graceful shutdown — explicitly publish presence=false with QoS 1 + retain,
   * await broker PUBACK (bounded by timeout), then teardown. Peers see us go
   * offline immediately instead of waiting for the broker's LWT timeout.
   *
   * Used by Electron `app.on('before-quit')`. If we Force-killed instead
   * (SIGKILL / Stop-Process -Force), this never runs and peers learn we're gone
   * only when the broker keepalive expires (typically 30-90s) — stale presence
   * window during which Mac shows Win as still online. See [DIAG:presence]
   * timeline 14:54-15:08 UTC on 2026-05-18 for the original symptom.
   *
   * Returns a Promise that resolves when either: (a) the PUBACK arrives and
   * teardown completes, or (b) the timeout fires and we tear down anyway.
   * Never rejects.
   */
  async gracefulShutdown(timeoutMs = 1200): Promise<void> {
    if (!this.client || !this.publicKeyBase64) {
      return;
    }
    const clientRef = this.client;
    const presenceTopic = this.getMyPresenceTopic();
    const offlineMessage: MqttMessage = {
      type: MessageType.PRESENCE,
      from: this.publicKeyBase64,
      payload: { online: false },
      timestamp: Date.now(),
    };
    const payload = JSON.stringify(offlineMessage);
    devLog('[MQTT] gracefulShutdown: publishing offline + teardown');
    diagLog('[DIAG:presence] gracefulShutdown publishing online=false');

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        diagLog('[DIAG:presence] gracefulShutdown: PUBACK timeout — proceeding to teardown');
        finish();
      }, timeoutMs);
      try {
        clientRef.publish(presenceTopic, payload, { qos: 1, retain: true }, (err) => {
          clearTimeout(timer);
          if (err) {
            devWarn('[MQTT] gracefulShutdown publish error:', err.message);
          } else {
            diagLog('[DIAG:presence] gracefulShutdown PUBACK received');
          }
          finish();
        });
      } catch (err) {
        clearTimeout(timer);
        devWarn('[MQTT] gracefulShutdown publish threw:', (err as Error).message);
        finish();
      }
    });

    try {
      this._teardown();
      this.publicKeyBase64 = null;
    } catch (err) {
      devWarn('[MQTT] gracefulShutdown teardown threw:', (err as Error).message);
    }
  }

  /**
   * token 到期前 2 分鐘先換新再換連線（稽核 B21）。以前只在 connect() 換 token，連線中從不換；broker 若在到期時
   * 斷線，就是每小時整點被踢、要等健康檢查（前景 10s、背景 30s）才重連。拿不到新 token 就保留現有連線、30 秒後再試。
   * 不延長 token 效期：被撤銷的裝置在效期內還能連。
   */
  private _scheduleTokenRenewal(delayOverride?: number): void {
    if (this._tokenRenewTimer) clearTimeout(this._tokenRenewTimer);
    this._tokenRenewTimer = null;
    if (!this._mqttTokenExpiresAt || !this.publicKeyBase64) return;
    const delay = delayOverride
      ?? Math.max(MqttService.TOKEN_RENEW_RETRY_MS, this._mqttTokenExpiresAt - Date.now() - MqttService.TOKEN_RENEW_BEFORE_MS);
    this._tokenRenewTimer = setTimeout(() => this._renewToken(), delay);
  }

  /**
   * token 效期（毫秒）＝JWT 的 exp − iat，跟本機時鐘無關（aegistrans_routes.py sign_mqtt_jwt 的 payload 有 iat、exp）。
   * 不是 JWT 或沒有 iat（舊 API）時退回 expiresAt − 收到時間，但至少 10 分鐘（時鐘快一小時的裝置不會每 30 秒換一次
   * 連線）、最多 1 天。
   */
  private static tokenLifetimeMs(token: string, expiresAtSec: number, receivedAt: number): number {
    try {
      const part = token.split('.')[1] ?? '';
      const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
      const { iat, exp } = JSON.parse(atob(base64)) as { iat?: unknown; exp?: unknown };
      if (typeof iat === 'number' && typeof exp === 'number' && exp > iat && exp - iat <= 86_400) return (exp - iat) * 1000;
    } catch { /* 不是 JWT：用 expiresAt */ }
    return Math.min(Math.max(expiresAtSec * 1000 - receivedAt, MqttService.MIN_TOKEN_LIFETIME_MS), 86_400_000);
  }

  /** 換 token 只在「已連上、沒有 connect 進行中」時做（對應 TofuTalk fc6910d：以前會把正在進行的 connect 拆掉） */
  private _canSwapConnection(): boolean {
    return !!this.client?.connected && !this.connectingPromise;
  }

  private async _renewToken(): Promise<void> {
    this._tokenRenewTimer = null;
    const key = this.publicKeyBase64;
    if (!key) return;
    if (!this._canSwapConnection()) {
      // 斷線中或正在連：不拆，稍後再看（重新連上時 'connect' 也會重新排定）
      this._scheduleTokenRenewal(MqttService.TOKEN_RENEW_RETRY_MS);
      return;
    }
    // 快取剩不到 5 分鐘 → _fetchMqttToken 會向伺服器要新的
    const token = await this._fetchMqttToken(key);
    if (this.publicKeyBase64 !== key) return;
    if (!token || !this._canSwapConnection()) {
      this._scheduleTokenRenewal(MqttService.TOKEN_RENEW_RETRY_MS);
      return;
    }
    devLog('[MQTT] token renewed before expiry → reconnecting with the new token');
    await this._swapConnection(key).catch((err) => devWarn('[MQTT] reconnect after token renewal failed:', err));
  }

  /**
   * 換 token 的整段換連線（好好斷線 → 用新 token 連上）算一次進行中的 connect：拔掉舊 client 之前就佔著 connectingPromise，
   * 到新連線連上（或失敗）為止。以前這段時間 this.client 是 null、沒有 connect 進行中 → health monitor 的 forceReconnect
   * 開第二條，換連線接著拆掉它再開第三條，第二條的 promise 永遠不 settle、monitor 卡在 reconnecting（AegisTrans 審查 B）。
   * 現在換連線中 connect() 跟著它、forceReconnect 等它完成。
   */
  private _swapConnection(key: string): Promise<void> {
    let swap: Promise<void> | null = null;
    const run = async (): Promise<void> => {
      await this._endGracefully();
      if (this.publicKeyBase64 !== key) return;   // 等待中登出（disconnect）
      this._teardown();
      this.connectingPromise = swap;              // _teardown 清掉了，換連線還沒完（同一個同步區段，中間沒有空窗）
      await this._open(key, this._isDev, swap);
    };
    const current: Promise<void> = run().finally(() => {
      if (this._swap === current) this._swap = null;
      if (this.connectingPromise === current) this.connectingPromise = null;
    });
    swap = current;
    this._swap = current;
    this.connectingPromise = current;
    return current;
  }

  /**
   * 換 token 時好好斷線：送 MQTT DISCONNECT（reason 0）→ broker 不發 last will，其他裝置不會看到這台離線
   * （對應 TofuTalk fc6910d：以前 end(true) 直接關 socket → 每小時 presence 閃一次離線）。最多等 2 秒，之後照常 teardown。
   * 對應 TofuTalk bcb9671（審查 LOW-2）：
   * - 等待中 broker 還會送 QoS 1 訊息，mqtt.js 照樣回 PUBACK（broker 就不會再送）→ 照常交給 handleMessage，直到斷線完成；
   *   只拔掉我們自己掛的 listener（狀態、重連），不再 removeAllListeners（那也拔掉 mqtt.js 自己在 close 時停 keepalive 的處理）。
   * - 等不到（DISCONNECT 還排在送出中的 QoS 1 後面）就直接關 socket。mqtt.js 5 的 end() 在斷線進行中再呼叫只回 callback，
   *   end(true) 關不掉；關 stream 後 mqtt.js 自己的 'close' 處理會停 keepalive。
   */
  private _endGracefully(timeoutMs = 2_000): Promise<void> {
    const client = this.client;
    if (!client) return Promise.resolve();
    this.client = null;   // 之後的 _teardown 不再碰這個 client（不再 end(true)）
    this._detachOwnListeners(client);
    this._listen(client, 'error', () => { /* swallow late errors on the closing client */ });
    const route = (topic: string, payload: Buffer) => {
      this._lastMessageReceivedAt = Date.now();
      this.handleMessage(topic, payload);
    };
    client.on('message', route);
    return new Promise<void>((resolve) => {
      let finished = false;
      const finish = (closeSocket: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          if (closeSocket) client.stream?.destroy();
          client.removeListener('message', route);
        } catch { /* already closed */ }
        resolve();
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      try {
        client.end(false, { reasonCode: 0 }, () => finish(false));
      } catch {
        finish(true);
      }
    });
  }

  /** 每個 client 上我們自己掛的 listener（拔掉用）；mqtt.js 自己掛的不在這裡 */
  private _ownListeners = new WeakMap<MqttClient, Array<() => void>>();

  private _listen<E extends keyof MqttClientEventCallbacks>(client: MqttClient, event: E, listener: MqttClientEventCallbacks[E]): void {
    client.on(event, listener);
    const detach = () => { client.removeListener(event, listener); };
    this._ownListeners.set(client, [...(this._ownListeners.get(client) ?? []), detach]);
  }

  private _detachOwnListeners(client: MqttClient): void {
    for (const detach of this._ownListeners.get(client) ?? []) detach();
    this._ownListeners.delete(client);
  }

  /**
   * 完全銷毀現有 MQTT client（共用方法）
   * 用於 forceReconnect / disconnect / connect 前清理
   */
  private _teardown(): void {
    if (this._tokenRenewTimer) { clearTimeout(this._tokenRenewTimer); this._tokenRenewTimer = null; }
    if (this.client) {
      try {
        this.client.removeAllListeners();
        // 補 no-op error handler：吞掉「垂死 client」在 removeAllListeners 之後才非同步 fire 的
        // connack-timeout 'error'（事後事件，try/catch 包不到 → 否則變 Uncaught Error 打斷重連/恢復流程）。
        // port 自 AegisTalk mqtt.ts（第零守則）。
        this.client.on('error', () => { /* swallow late errors on dying client */ });
        this.client.end(true);
      } catch {
        // Ignore cleanup errors
      }
      this.client = null;
    }
    this.connectingPromise = null;
    // 還沒連上的那次連線被拆掉：讓它的 promise reject（以前永遠不 settle，等它的 health monitor 卡在 reconnecting）
    const abort = this._abortConnect;
    this._abortConnect = null;
    abort?.(new Error('MQTT connection torn down before it connected'));
    // Reset per-client subscription tracking — without this, on reconnect the
    // useDevicePresence hook re-asks subscribeToFriendPresence(peer), but the
    // Set still says "already subscribed" from the previous (dead) client →
    // service skips the actual subscribe call → peer presence never arrives
    // → app appears to require manual re-login to see peers online again.
    this.subscribedPresenceTopics.clear();
    this.friendPresence.clear();
    this.friendLastSeen.clear();
    this.stopPresenceHeartbeat();
    this.stopPresenceStaleSweep();
    this.setState(ConnectionState.DISCONNECTED);
  }

  /**
   * 強制重新連線 — 完全銷毀 client + 新建連線
   *
   * 由 MqttHealthMonitor 呼叫，不再有 guard 阻止。
   * 這是應對 OS 殺 socket 後唯一有效的恢復方式。
   */
  async forceReconnect(): Promise<void> {
    const savedKey = this.publicKeyBase64;
    if (!savedKey) {
      console.error('[MQTT] forceReconnect: no publicKey, skipping');
      return;
    }

    // 換 token 的換連線進行中（舊 client 已拔掉、新的還沒連上）：那本身就是一次重連 → 等它完成，不拆掉另開（AegisTrans 審查 B）
    if (this._swap) {
      devLog('[MQTT] forceReconnect: token-renewal swap in progress, waiting for it');
      await this._swap.catch(() => { /* 換連線失敗：下一次 probe 再處理 */ });
      return;
    }

    // If mqtt.js reports connected AND the underlying WebSocket is actually open,
    // skip force reconnect — the connection is alive
    if (this.client?.connected) {
      const ws = (this.client as unknown as { stream?: { socket?: WebSocket } })?.stream?.socket;
      if (ws && ws.readyState === WebSocket.OPEN) {
        devLog('[MQTT] forceReconnect: already connected (ws=OPEN), skipping');
        return;
      }
      // WebSocket is not OPEN despite mqtt.js thinking it's connected — zombie state
      devWarn(`[MQTT] forceReconnect: zombie detected (ws.readyState=${ws?.readyState})`);
    }

    // 不再有 "mqtt.js is internally reconnecting" guard
    // reconnectPeriod=0 已停用 mqtt.js 內建重連，此 guard 不再需要

    devWarn('[MQTT] forceReconnect: tearing down...');
    this._teardown();
    devLog('[MQTT] forceReconnect: reconnecting...');
    await this.connect(savedKey, this._isDev);
  }

  /**
   * 訂閱預設主題
   */
  private subscribeToDefaultTopics(): void {
    if (!this.client) return;

    const topics = this.getTopics();

    // 訂閱個人收件箱
    this.client.subscribe(topics.inbox, { qos: 1 }, (err) => {
      if (err) {
        devWarn('[MQTT] Failed to subscribe to inbox:', err);
      } else {
        devLog('[MQTT] Subscribed to inbox');
      }
    });

    // 訂閱廣播頻道
    this.client.subscribe(topics.broadcast, { qos: 0 }, (err) => {
      if (err) {
        devWarn('[MQTT] Failed to subscribe to broadcast:', err);
      } else {
        devLog('[MQTT] Subscribed to broadcast');
      }
    });

    // 4c281d0 之前的全域廣播 topic：clean:false 的 session 會把舊版的訂閱還原回來 → 退訂（收到的也會被 isOwnTopic 丟掉）
    if (this.accountUserId) {
      this.client.unsubscribe(MqttService.LEGACY_GLOBAL_TOPICS, (err?: Error) => {
        if (err) devWarn('[MQTT] Failed to unsubscribe legacy global topics:', err);
      });
    }

    // Phase 35b: 訂閱本裝置的 kick 通道（VPS 即時踢下線推播）
    try {
      const kickTopic = this.kickTopic();
      if (kickTopic && this.client) {
        this.client.subscribe(kickTopic, { qos: 1 }, (err) => {
          if (err) {
            devWarn('[MQTT] Failed to subscribe to kick topic:', err);
          } else {
            devLog('[MQTT] Subscribed to kick topic:', kickTopic);
          }
        });
      }
    } catch (e) {
      devWarn('[MQTT] kick subscribe error:', e);
    }

    // 帳號裝置名冊公告：訂閱它（收別台加入的 ping）+ 自己一連上就 ping 一次
    //（宣告「我在這」）→ 其他裝置立即重抓清單看到我。與 pubkey 無關，補上 presence
    // 無法「發現未知新裝置」的缺口。
    const rt = this.rosterTopic();
    if (rt) {
      this.client.subscribe(rt, { qos: 1 }, (err) => {
        if (err) devWarn('[MQTT] Failed to subscribe roster topic:', err);
        else devLog('[MQTT] Subscribed roster topic');
      });
      // 換 token 的重連（每小時）裝置沒變：不發，不然每台裝置每小時都讓其他裝置 invalidate、重抓清單（AegisTrans 審查 C）
      if (!this._swap) this.publishRosterPing();
    }

    // Phase 5: 發布上線狀態（retain=true 讓新訂閱者能收到）
    this.publishPresence(true);

    // Heartbeat re-publish: broker 的 LWT 在 keepalive miss 時會 fire 一條 retained
    // online=false,即使本 client 後來恢復也不會自動覆寫(無法區分「LWT 觸發」vs
    // 「我們真的下線」)。週期性 republish 保證 retained 始終反映實際狀態,避免
    // 「我還線上但對方看到我離線」(直到我重啟才修復) 的 UX bug。
    this.startPresenceHeartbeat();
    this.startPresenceStaleSweep();
  }

  // Staleness sweep:定時把「超過 PRESENCE_STALE_MS 沒任何消息」的 online peer 標 offline。
  // 修「對端真的不見了(死掉/從未連上/網路斷)卻一直顯示 online」的 sticky-presence bug。
  private _presenceStaleTimer: ReturnType<typeof setInterval> | null = null;
  private startPresenceStaleSweep(): void {
    if (this._presenceStaleTimer) clearInterval(this._presenceStaleTimer);
    this._presenceStaleTimer = setInterval(() => {
      const now = Date.now();
      this.friendPresence.forEach((isOnline, peer) => {
        if (!isOnline) return;
        const last = this.friendLastSeen.get(peer);
        // 從沒記過 last-seen 的 peer 不掃（避免 reconnect 清空 friendLastSeen 後、
        // 某 peer 才剛被標 online 但 last 還沒寫入時 now-0 立刻誤判離線）。
        if (last === undefined) return;
        if (now - last > PRESENCE_STALE_MS) {
          this.friendPresence.set(peer, false);
          diagLog(`[DIAG:presence] STALE → offline senderKey=${peer.slice(0, 16)} (silent ${Math.round((now - last) / 1000)}s)`);
          this.presenceListeners.forEach((cb) => cb(peer, false));
        }
      });
    }, 30_000);  // 每 30s 掃一次
  }
  private stopPresenceStaleSweep(): void {
    if (this._presenceStaleTimer) {
      clearInterval(this._presenceStaleTimer);
      this._presenceStaleTimer = null;
    }
  }

  private _presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startPresenceHeartbeat(): void {
    if (this._presenceHeartbeatTimer) {
      clearInterval(this._presenceHeartbeatTimer);
    }
    this._presenceHeartbeatTimer = setInterval(() => {
      // Health monitor 負責 reconnect。這邊純做 retained presence 心跳 — broker 上
      // 的 LWT 可能在 keepalive race 時 fire 過,即使我們已經恢復連線,retained 仍是
      // online=false 直到下次 publish。週期 republish 保證 retained 反映實際狀態。
      if (this.client?.connected) {
        this.publishPresence(true);
      }
    }, 30_000);  // 30 秒一次
  }
  private stopPresenceHeartbeat(): void {
    if (this._presenceHeartbeatTimer) {
      clearInterval(this._presenceHeartbeatTimer);
      this._presenceHeartbeatTimer = null;
    }
  }

  /**
   * 訂閱群組頻道
   */
  subscribeToGroup(groupId: string): void {
    if (!this.client) {
      throw new Error('Not connected');
    }

    const topic = this.getTopics().group(groupId);
    this.client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        devWarn(`[MQTT] Failed to subscribe to group ${groupId}:`, err);
      } else {
        devLog(`[MQTT] Subscribed to group ${groupId}`);
      }
    });
  }

  /**
   * 取消訂閱群組頻道
   */
  unsubscribeFromGroup(groupId: string): void {
    if (!this.client) return;

    const topic = this.getTopics().group(groupId);
    this.client.unsubscribe(topic);
    devLog(`[MQTT] Unsubscribed from group ${groupId}`);
  }

  // ============================================
  // Phase 5: Presence 追蹤
  // ============================================

  /**
   * 發布自己的 presence 狀態
   */
  private publishPresence(isOnline: boolean): void {
    if (!this.client || !this.publicKeyBase64) return;

    const presenceTopic = this.getMyPresenceTopic();
    const message: MqttMessage = {
      type: MessageType.PRESENCE,
      from: this.publicKeyBase64,
      payload: { online: isOnline },
      timestamp: Date.now(),
    };

    // retain=true 確保新訂閱者能收到最新狀態
    this.client.publish(presenceTopic, JSON.stringify(message), {
      qos: 1,
      retain: true,
    });

    devLog(`[MQTT] Published presence: ${isOnline ? 'online' : 'offline'}`);
    diagLog(`[DIAG:presence] PUBLISH topic=${presenceTopic.slice(-40)} online=${isOnline}`);
  }

  /**
   * 訂閱好友的 presence 狀態
   */
  subscribeToFriendPresence(friendPublicKey: string): void {
    if (!this.client) {
      devWarn('[MQTT] Cannot subscribe to presence: not connected');
      diagLog(`[DIAG:presence] SUBSCRIBE SKIPPED no-client friend=${friendPublicKey.slice(0, 12)}`);
      return;
    }

    const topic = this.getTopics().presence(friendPublicKey);

    // 避免重複訂閱
    if (this.subscribedPresenceTopics.has(topic)) {
      diagLog(`[DIAG:presence] SUBSCRIBE SKIPPED already-subbed topic=${topic.slice(-40)}`);
      return;
    }

    diagLog(`[DIAG:presence] SUBSCRIBE ATTEMPT topic=${topic.slice(-40)}`);
    this.client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        devWarn('[MQTT] Failed to subscribe to presence:', err);
        diagLog(`[DIAG:presence] SUBSCRIBE FAILED err=${err.message}`);
      } else {
        this.subscribedPresenceTopics.add(topic);
        devLog(`[MQTT] Subscribed to presence for ${friendPublicKey.slice(0, 8)}...`);
        diagLog(`[DIAG:presence] SUBSCRIBE OK topic=${topic.slice(-40)}`);
      }
    });
  }

  /**
   * 訂閱多個好友的 presence 狀態
   */
  subscribeToFriendsPresence(friendPublicKeys: string[]): void {
    for (const pubKey of friendPublicKeys) {
      this.subscribeToFriendPresence(pubKey);
    }
  }

  /**
   * 監聯好友 presence 變化
   */
  onPresenceChange(callback: PresenceCallback): () => void {
    this.presenceListeners.add(callback);
    return () => {
      this.presenceListeners.delete(callback);
    };
  }

  /**
   * 取得好友的在線狀態
   */
  isFriendOnline(friendPublicKey: string): boolean {
    return this.friendPresence.get(friendPublicKey) ?? false;
  }

  /**
   * 發送訊息給指定用戶
   * @param recipientPublicKeyBase64 接收者公鑰
   * @param type 訊息類型
   * @param payload 訊息內容
   * @param pushData 可選的離線推播資料（接收方的 Push Subscription）
   * @param notificationHint 可選的通知提示（供原生 Guardian 服務顯示通知）
   */
  sendToUser(
    recipientPublicKeyBase64: string,
    type: MessageType,
    payload: unknown,
    pushData?: PushData,
    notificationHint?: NotificationHint
  ): void {
    if (!this.publicKeyBase64) {
      throw new Error('No public key configured');
    }

    // 將接收者公鑰轉換為 URL 安全格式用於主題
    const safeRecipientKey = toUrlSafeBase64(recipientPublicKeyBase64);
    const topic = this.userTopic(safeRecipientKey, 'inbox');
    const message: MqttMessage = {
      type,
      from: this.publicKeyBase64,  // 保持原始格式用於識別
      to: recipientPublicKeyBase64,
      payload,
      timestamp: Date.now(),
      pushData, // 附加推播資料（如果提供）
      ...(notificationHint ? { notificationHint } : {}),
    };

    const jsonPayload = JSON.stringify(message);

    // 離線時緩衝到 outgoingQueue，重連後自動 flush
    if (!this.client?.connected) {
      if (type === MessageType.DELETE_MESSAGE) {
        diagLog('[DIAG:MQTT:QUEUE] DELETE_MESSAGE enqueued (offline) topic=' + topic);
      }
      this._enqueueOutgoing(topic, jsonPayload, 1);
      return;
    }

    this.client.publish(topic, jsonPayload, { qos: 1 });

    if (type === MessageType.DELETE_MESSAGE) {
      diagLog('[DIAG:MQTT:PUB] DELETE_MESSAGE published topic=' + topic);
    }

    // （AegisTalk 留下的「發送方呼叫 AegisTalk 推播 API 喚醒對方」已移除：AegisTrans 沒有推播，
    //   也沒有任何呼叫端帶 notificationHint。）
  }

  /**
   * 廣播訊息
   */
  broadcast(type: MessageType, payload: unknown): void {
    if (!this.publicKeyBase64) {
      throw new Error('No public key configured');
    }

    const message: MqttMessage = {
      type,
      from: this.publicKeyBase64,
      payload,
      timestamp: Date.now(),
    };

    const topic = this.getTopics().broadcast;
    const jsonPayload = JSON.stringify(message);

    if (!this.client?.connected) {
      this._enqueueOutgoing(topic, jsonPayload, 0);
      return;
    }

    this.client.publish(topic, jsonPayload, { qos: 0 });
  }

  /**
   * 發送訊息到群組
   */
  sendToGroup(groupId: string, type: MessageType, payload: unknown): void {
    if (!this.publicKeyBase64) {
      throw new Error('No public key configured');
    }

    const topic = this.getTopics().group(groupId);
    const message: MqttMessage = {
      type,
      from: this.publicKeyBase64,
      payload,
      timestamp: Date.now(),
    };

    const jsonPayload = JSON.stringify(message);

    if (!this.client?.connected) {
      this._enqueueOutgoing(topic, jsonPayload, 1);
      return;
    }

    this.client.publish(topic, jsonPayload, { qos: 1 });
  }

  /**
   * 驗證 MQTT 訊息結構
   * 防止惡意 / 畸形訊息被處理
   */
  private validateMessage(parsed: unknown): parsed is MqttMessage {
    if (!parsed || typeof parsed !== 'object') return false;
    const msg = parsed as Record<string, unknown>;

    // 必要欄位檢查
    if (typeof msg.type !== 'string' || !msg.type) return false;
    if (typeof msg.from !== 'string' || !msg.from) return false;
    if (typeof msg.timestamp !== 'number') return false;

    // from 欄位格式驗證：Base64 公鑰（32+ bytes → 44+ chars base64）
    if (msg.from.length < 20 || !/^[A-Za-z0-9+/=]+$/.test(msg.from)) return false;

    // type 必須是已知的 MessageType 值
    const knownTypes = Object.values(MessageType) as string[];
    if (!knownTypes.includes(msg.type)) return false;

    // 時間戳新鮮度檢查（防止重放攻擊）
    // 持久化訊息允許 24h（EMQX session 保留期），即時信號類訊息使用 5 分鐘
    // 配對信令（prekey_request／prekey_bundle）刻意留在 5 分鐘（傳輸統一 X3）：裝置一連上就發 roster ping
    // → 其他裝置 refreshDevices → 對沒 session 的裝置重發 PREKEY_REQUEST，不靠 broker 排隊；放寬到 24h
    // 反而會讓排隊多時的 sessionReset 請求在對方上線後把已修好的 session 再拆一次。
    const PERSISTENT_MSG_TYPES = [
      'x3dh_init', 'encrypted_message',
      'profile_update', 'profile_request', 'invite_accept',
      'push_subscription_update', 'check_in_reminder',
    ];
    const MESSAGE_FRESHNESS_MS = PERSISTENT_MSG_TYPES.includes(msg.type as string)
      ? 24 * 60 * 60 * 1000
      : 5 * 60 * 1000;
    // 離線遺囑（LWT）的時戳是連線當下寫好的：連線超過 5 分鐘後斷線，遺囑一到就會被當成過期丟掉
    // → 其他裝置一直顯示它在線，晚訂閱的也看不到 retained 的離線（傳輸統一 X2）。離線宣告最壞只讓裝置
    // 暫時顯示離線（30s presence 心跳或任何訊息就更正），presence 主題又只有同帳號裝置能發，所以不擋時戳；
    // 在線宣告照舊 5 分鐘（否則斷線裝置殘留的舊「在線」會把它復活）。
    const isOfflinePresence = msg.type === MessageType.PRESENCE
      && (msg.payload as { online?: unknown } | null)?.online === false;
    const timeDiff = Math.abs(Date.now() - (msg.timestamp as number));
    if (timeDiff > MESSAGE_FRESHNESS_MS && !isOfflinePresence) {
      console.warn('[MQTT] Message rejected: timestamp too old/future, type:', msg.type, 'diff:', Math.round(timeDiff / 1000) + 's');
      return false;
    }

    return true;
  }

  /**
   * 處理收到的訊息
   */
  private handleMessage(topic: string, payload: Buffer): void {
    if (!this.isOwnTopic(topic)) {
      devWarn('[MQTT] Dropped a message on a topic outside this account:', topic.slice(0, 48));
      return;
    }
    try {
      const parsed = JSON.parse(payload.toString());

      // Phase 35b: 即時踢下線通知（不解密，dispatch 事件給上層驗證）
      if (topic.startsWith('aegis/device/') && topic.endsWith('/kicked') && parsed.type === 'kicked') {
        devLog('[MQTT] Device kick signal received on:', topic);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('aegis:device-kick-signal', { detail: parsed }));
        }
        return;
      }

      // 帳號裝置名冊 ping（別台加入/名冊變動）→ 通知上層立即重抓 listDevices。
      // 不解密、不驗 MessageType；忽略自己發的 ping。
      if (topic.startsWith('mist/acct/') && topic.endsWith('/devices')) {
        if (parsed?.from !== this.publicKeyBase64) {
          devLog('[MQTT] roster ping — refreshing device list');
          this.rosterListeners.forEach((cb) => { try { cb(); } catch { /* listener 錯誤不影響其他 */ } });
        }
        return;
      }

      // E2EE Phase 2: 檢查是否為 Sealed 訊息
      if (parsed.sealed === true && parsed.envelope) {
        devLog('[MQTT] Received sealed message');
        this.handleSealedMessage(parsed as SealedMqttMessage);
        return;
      }

      // 驗證訊息結構
      if (!this.validateMessage(parsed)) {
        devWarn('[MQTT] Rejected malformed message on topic:', topic);
        return;
      }

      const message: MqttMessage = parsed;

      // 忽略自己發送的訊息
      if (message.from === this.publicKeyBase64) {
        return;
      }

      diagLog(`[DIAG:mqtt-in] type=${message.type} from=${message.from.slice(0, 16)} topic=${topic.slice(-24)}`);

      devLog(`[MQTT] Received ${message.type} from ${message.from.slice(0, 8)}...`);

      // 收到對方任何訊息(含 presence 心跳)→ 更新 last-seen,供 staleness sweep 判活。
      // online=false 的 presence 也會更新,但無妨:presence handler 會把它設 offline,
      // sweep 只掃 online 的 peer,所以不影響。
      if (message.from) {
        this.friendLastSeen.set(message.from, Date.now());
      }

      // 收到任何訊息 (除 presence 自己) 就把 sender 標為 online。Broker 的 retained
      // presence 不可靠 (LWT 在 keepalive race 時 fire,直到對方 republish 才修),
      // 所以我們用「實際有收到對方訊息」當作 online 的權威指標。Presence 訊息本身
      // 走原本 payload 解析路徑,不在這邊提早判定避免 false→true→false 來回。
      if (message.type !== MessageType.PRESENCE) {
        const senderKey = message.from;
        const wasOnline = this.friendPresence.get(senderKey);
        if (wasOnline !== true) {
          this.friendPresence.set(senderKey, true);
          diagLog(`[DIAG:presence] INFER online from activity senderKey=${senderKey.slice(0, 16)} (was=${wasOnline})`);
          this.presenceListeners.forEach((callback) => callback(senderKey, true));
        }
      }

      // Phase 5: 處理 presence 訊息
      if (message.type === MessageType.PRESENCE && topic.includes('/presence')) {
        const presencePayload = message.payload as { online: boolean };
        const senderKey = message.from;
        const wasOnline = this.friendPresence.get(senderKey);
        const isOnline = presencePayload.online;

        this.friendPresence.set(senderKey, isOnline);
        diagLog(`[DIAG:presence] STATE senderKey=${senderKey.slice(0, 16)} was=${wasOnline} now=${isOnline} listeners=${this.presenceListeners.size}`);

        // 只在狀態改變時通知監聯器
        if (wasOnline !== isOnline) {
          devLog(`[MQTT] Friend ${senderKey.slice(0, 8)}... is now ${isOnline ? 'online' : 'offline'}`);
          diagLog(`[DIAG:presence] NOTIFY ${this.presenceListeners.size} listeners senderKey=${senderKey.slice(0, 16)}`);
          this.presenceListeners.forEach((callback) => callback(senderKey, isOnline));
        }
      }

      // 通知監聽器
      const listeners = this.messageListeners.get(message.type);
      if (listeners && listeners.size > 0) {
        listeners.forEach((callback) => callback(message));
      } else {
        // 無 listener：暫存訊息，等 listener 註冊時重播
        // 修復 MQTT 重連競爭條件：broker 送出暫存訊息時 React useEffect 尚未註冊 listener
        const typeKey = message.type as string;
        const pending = this.pendingMessages.get(typeKey) || [];
        pending.push(message);
        this.pendingMessages.set(typeKey, pending);
        devLog(`[MQTT] Buffered message type=${typeKey} (no listener yet, ${pending.length} pending)`);

        // 關鍵訊息類型（X3DH、session 建立等）永不自動清除
        // 這些訊息必須等到 React useEffect 註冊 listener 後才能處理
        // AppProvider 的 X3DH_INIT listener 依賴 cryptoReady，可能延遲數十秒
        // ⚠️ 用線上型別字串（MessageType.PRE_KEY_BUNDLE = 'prekey_bundle'）；舊寫成 'pre_key_bundle' 從未命中
        const CRITICAL_TYPES: readonly string[] = [
          'x3dh_init', 'prekey_request', 'prekey_bundle',
          'invite_accept', 'encrypted_message',
        ];
        const isCritical = CRITICAL_TYPES.includes(typeKey);
        const bufferTimeout = isCritical ? 120_000 : 30_000; // 關鍵訊息 2 分鐘，其他 30 秒

        const existingTimer = this.pendingMessageTimers.get(typeKey);
        if (existingTimer) clearTimeout(existingTimer);
        this.pendingMessageTimers.set(typeKey, setTimeout(() => {
          const remaining = this.pendingMessages.get(typeKey);
          if (remaining && remaining.length > 0) {
            console.warn(`[MQTT] Discarding ${remaining.length} buffered ${typeKey} messages after ${bufferTimeout / 1000}s (no listener registered)`);
          }
          this.pendingMessages.delete(typeKey);
          this.pendingMessageTimers.delete(typeKey);
        }, bufferTimeout));
      }

      // 通知全局監聯器
      const allListeners = this.messageListeners.get('*' as MessageType);
      if (allListeners) {
        allListeners.forEach((callback) => callback(message));
      }
    } catch (error) {
      devWarn('[MQTT] Failed to parse message:', error);
    }
  }

  /**
   * 設定連線狀態
   */
  private setState(state: ConnectionState): void {
    this.state = state;
    this.stateListeners.forEach((callback) => callback(state));
  }

  /**
   * 取得當前連線狀態
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * 監聽特定類型的訊息
   */
  onMessage(type: MessageType | '*', callback: MessageCallback): () => void {
    const typeKey = type as MessageType;
    if (!this.messageListeners.has(typeKey)) {
      this.messageListeners.set(typeKey, new Set());
    }
    this.messageListeners.get(typeKey)!.add(callback);

    // 重播緩衝訊息：修復 MQTT 重連時 listener 尚未註冊導致訊息丟失
    const pendingKey = type as string;
    const pending = this.pendingMessages.get(pendingKey);
    if (pending && pending.length > 0) {
      devLog(`[MQTT] Replaying ${pending.length} buffered ${pendingKey} messages`);
      const toReplay = [...pending];
      this.pendingMessages.delete(pendingKey);
      const timer = this.pendingMessageTimers.get(pendingKey);
      if (timer) {
        clearTimeout(timer);
        this.pendingMessageTimers.delete(pendingKey);
      }
      // 微延遲確保所有 listener 都已註冊完畢
      queueMicrotask(() => {
        for (const msg of toReplay) {
          try {
            callback(msg);
          } catch (err) {
            devWarn(`[MQTT] Error replaying buffered ${pendingKey}:`, err);
          }
        }
      });
    }

    // 返回取消監聽的函式
    return () => {
      this.messageListeners.get(typeKey)?.delete(callback);
    };
  }

  /**
   * 監聽連線狀態變化
   */
  onStateChange(callback: StateCallback): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  /**
   * 發送 WebRTC Offer
   */
  sendOffer(recipientPublicKeyBase64: string, offer: RTCSessionDescriptionInit): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.WEBRTC_OFFER, offer);
  }

  /**
   * 發送 WebRTC Answer
   */
  sendAnswer(recipientPublicKeyBase64: string, answer: RTCSessionDescriptionInit): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.WEBRTC_ANSWER, answer);
  }

  /**
   * 發送 ICE Candidate
   */
  sendIceCandidate(recipientPublicKeyBase64: string, candidate: RTCIceCandidate): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.WEBRTC_ICE, candidate);
  }

  /**
   * 廣播 PreKeyBundle
   */
  broadcastPreKeyBundle(bundle: string): void {
    this.broadcast(MessageType.PRE_KEY_BUNDLE, { bundle });
  }

  /**
   * 發送 X3DH 初始訊息
   */
  sendX3DHInit(recipientPublicKeyBase64: string, initMessage: string): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.X3DH_INIT, {
      initMessage,
    });
  }

  /**
   * 發送在線狀態
   */
  broadcastPresence(isOnline: boolean): void {
    this.broadcast(MessageType.PRESENCE, { online: isOnline });
  }

  /**
   * 發送正在輸入狀態
   */
  sendTyping(recipientPublicKeyBase64: string, isTyping: boolean): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.TYPING, {
      typing: isTyping,
    });
  }

  // ============================================
  // 語音通話信令
  // ============================================

  /**
   * 發送通話請求
   */
  sendCallRequest(recipientPublicKeyBase64: string, options?: { isVideoCall?: boolean; callerName?: string }): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.CALL_REQUEST, {
      timestamp: Date.now(),
      isVideoCall: options?.isVideoCall ?? false,
    }, undefined, {
      type: 'incoming_call',
      senderName: options?.callerName,
      isVideoCall: options?.isVideoCall ?? false,
    });
  }

  /**
   * 接受通話
   */
  sendCallAccept(recipientPublicKeyBase64: string): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.CALL_ACCEPT, {
      timestamp: Date.now(),
    });
  }

  /**
   * 拒絕通話
   */
  sendCallReject(recipientPublicKeyBase64: string, reason?: string): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.CALL_REJECT, {
      reason: reason || 'declined',
      timestamp: Date.now(),
    });
  }

  /**
   * 結束通話
   */
  sendCallEnd(recipientPublicKeyBase64: string): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.CALL_END, {
      timestamp: Date.now(),
    });
  }

  /**
   * 發送語音通話專用 WebRTC Offer
   */
  sendCallOffer(recipientPublicKeyBase64: string, offer: RTCSessionDescriptionInit): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.CALL_WEBRTC_OFFER, offer);
  }

  /**
   * 發送語音通話專用 WebRTC Answer
   */
  sendCallAnswer(recipientPublicKeyBase64: string, answer: RTCSessionDescriptionInit): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.CALL_WEBRTC_ANSWER, answer);
  }

  /**
   * 發送語音通話專用 ICE Candidate
   */
  sendCallIceCandidate(recipientPublicKeyBase64: string, candidate: RTCIceCandidate): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.CALL_WEBRTC_ICE, candidate);
  }

  // ============================================
  // 個人資料同步
  // ============================================

  /**
   * 發送個人資料更新給指定好友
   */
  sendProfileUpdate(
    recipientPublicKeyBase64: string,
    profile: { displayName: string; avatar: string }
  ): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.PROFILE_UPDATE, {
      displayName: profile.displayName,
      avatar: profile.avatar,
      timestamp: Date.now(),
    });
  }

  /**
   * 廣播個人資料更新給所有好友
   * @param friendPublicKeys 好友公鑰列表
   * @param profile 個人資料
   */
  broadcastProfileUpdate(
    friendPublicKeys: string[],
    profile: { displayName: string; avatar: string }
  ): void {
    for (const friendKey of friendPublicKeys) {
      this.sendProfileUpdate(friendKey, profile);
    }
    devLog(`[MQTT] Profile update sent to ${friendPublicKeys.length} friends`);
  }

  /**
   * 發送推播訂閱更新給好友
   * @param recipientPublicKeyBase64 對方公鑰
   * @param pushSubscription 推播訂閱資料（null 表示取消訂閱）
   */
  sendPushSubscriptionUpdate(
    recipientPublicKeyBase64: string,
    pushSubscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      expirationTime?: number | null;
    } | null
  ): void {
    this.sendToUser(recipientPublicKeyBase64, MessageType.PUSH_SUBSCRIPTION_UPDATE, {
      pushSubscription,
      timestamp: Date.now(),
    });
  }

  /**
   * 廣播推播訂閱更新給所有好友
   * @param friendPublicKeys 好友公鑰列表
   * @param pushSubscription 推播訂閱資料
   */
  broadcastPushSubscriptionUpdate(
    friendPublicKeys: string[],
    pushSubscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      expirationTime?: number | null;
    } | null
  ): void {
    for (const friendKey of friendPublicKeys) {
      this.sendPushSubscriptionUpdate(friendKey, pushSubscription);
    }
    devLog(`[MQTT] Push subscription update sent to ${friendPublicKeys.length} friends`);
  }

  /**
   * 訂閱特定訊息類型
   * 這是一個便利方法，用於 hook 中訂閱訊息
   */
  subscribe(type: MessageType | '*', callback: MessageCallback): () => void {
    return this.onMessage(type, callback);
  }

  /**
   * 檢查是否已連接
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED && this.client?.connected === true;
  }

  // ============================================
  // Phase 8: 換機傳輸（場景 2）
  // ============================================

  /**
   * 發送換機傳輸請求（新設備發送）
   */
  sendDeviceTransferRequest(
    targetPublicKey: string,
    payload: {
      timestamp: number;
    }
  ): void {
    this.sendToUser(targetPublicKey, MessageType.DEVICE_TRANSFER_REQUEST, payload);
    devLog(`[MQTT] Device transfer request sent to ${targetPublicKey.slice(0, 8)}...`);
  }

  /**
   * 發送換機傳輸資料（舊設備發送）
   */
  sendDeviceTransferData(
    targetPublicKey: string,
    payload: {
      encryptedPayload: {
        iv: string;
        ciphertext: string;
        tag: string;
      };
      timestamp: number;
    }
  ): void {
    this.sendToUser(targetPublicKey, MessageType.DEVICE_TRANSFER_DATA, payload);
    devLog(`[MQTT] Device transfer data sent to ${targetPublicKey.slice(0, 8)}...`);
  }

  // ============================================
  // 離線訊息緩衝 + Health Monitor API
  // ============================================

  /**
   * 緩衝離線待發訊息
   */
  private _enqueueOutgoing(topic: string, payload: string, qos: 0 | 1 | 2): void {
    if (this.outgoingQueue.length >= MqttService.MAX_OUTGOING_QUEUE) {
      // 丟棄最舊的訊息
      this.outgoingQueue.shift();
    }
    this.outgoingQueue.push({ topic, payload, qos, timestamp: Date.now() });
    devLog(`[MQTT] Queued outgoing message (${this.outgoingQueue.length} pending)`);
  }

  /**
   * 重連後 flush 所有緩衝的待發訊息
   */
  private _flushOutgoingQueue(): void {
    if (!this.client?.connected || this.outgoingQueue.length === 0) return;

    const count = this.outgoingQueue.length;
    devLog(`[MQTT] Flushing ${count} queued outgoing messages`);

    const queue = [...this.outgoingQueue];
    this.outgoingQueue = [];

    for (const msg of queue) {
      // 丟棄超過 5 分鐘的訊息（已過時）
      if (Date.now() - msg.timestamp > 5 * 60_000) {
        devWarn(`[MQTT] Dropped stale outgoing message (age=${Math.round((Date.now() - msg.timestamp) / 1000)}s)`);
        continue;
      }
      try {
        this.client.publish(msg.topic, msg.payload, { qos: msg.qos });
      } catch (err) {
        devWarn('[MQTT] Failed to flush queued message:', err);
      }
    }
  }

  /**
   * 取得連線健康資訊（供 MqttHealthMonitor 使用）
   */
  getHealthInfo(): MqttHealthInfo {
    const ws = (this.client as unknown as { stream?: { socket?: WebSocket } })?.stream?.socket;
    return {
      state: this.state,
      wsReadyState: ws?.readyState ?? null,
      lastMessageReceivedAt: this._lastMessageReceivedAt,
      clientConnected: this.client?.connected ?? false,
      publicKey: this.publicKeyBase64,
      tokenFailed: this._tokenFetchFailedAt > 0 &&
        Date.now() - this._tokenFetchFailedAt < MqttService.TOKEN_RETRY_COOLDOWN,
      hasPinHash: !!localStorage.getItem('mist_pin_hash'),
    };
  }

  /**
   * 重置 token 失敗狀態（VPS 註冊成功後呼叫）
   */
  resetTokenFailure(): void {
    this._tokenFetchFailedAt = 0;
    this._mqttToken = null;
    this._mqttTokenExpiresAt = 0;
  }

  /**
   * 處理 Sealed 訊息
   */
  private async handleSealedMessage(sealedMessage: SealedMqttMessage): Promise<void> {
    if (!this.privateKeyBase64) {
      devWarn('[MQTT] Cannot unseal message: private key not configured');
      return;
    }

    try {
      const result = await unsealMessageBase64(
        sealedMessage.envelope,
        this.privateKeyBase64
      );

      devLog(`[MQTT] Unsealed message from ${result.from.slice(0, 8)}..., type: ${result.type}`);

      // 通知 Sealed 訊息監聽器
      this.sealedMessageListeners.forEach((callback) => callback(result));

      // 同時也轉換為標準訊息格式通知一般監聽器
      const standardMessage: MqttMessage = {
        type: result.type as MessageType,
        from: result.from,
        payload: result.payload,
        timestamp: result.timestamp,
        signature: result.signature,
      };

      const listeners = this.messageListeners.get(result.type as MessageType);
      if (listeners && listeners.size > 0) {
        listeners.forEach((callback) => callback(standardMessage));
      } else {
        // 緩衝無 listener 的 sealed 訊息（同 handleMessage 邏輯）
        const typeKey = result.type as string;
        const pending = this.pendingMessages.get(typeKey) || [];
        pending.push(standardMessage);
        this.pendingMessages.set(typeKey, pending);
        devLog(`[MQTT] Buffered sealed message type=${typeKey} (no listener, ${pending.length} pending)`);
        const existingTimer = this.pendingMessageTimers.get(typeKey);
        if (existingTimer) clearTimeout(existingTimer);
        this.pendingMessageTimers.set(typeKey, setTimeout(() => {
          this.pendingMessages.delete(typeKey);
          this.pendingMessageTimers.delete(typeKey);
        }, 30_000));
      }

      const allListeners = this.messageListeners.get('*' as MessageType);
      if (allListeners) {
        allListeners.forEach((callback) => callback(standardMessage));
      }
    } catch (error) {
      devWarn('[MQTT] Failed to unseal message:', error);
    }
  }
}

// 單例導出
export const mqttService = new MqttService();

export default mqttService;
