// Mist Demo Types

/** 信任等級 */
export type TrustLevel = 'verified' | 'unverified';

/** Web Push 訂閱資料（用於離線推播） */
export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
}

export interface Friend {
  id: string;
  publicKey: string; // Base64 公鑰
  name: string;
  avatar: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  online: boolean;
  trustLevel: TrustLevel; // 🟢 已驗證 / 🟡 未驗證
  addedAt: number; // 加入時間
  pushSubscription?: PushSubscriptionData; // 推播訂閱資料（加好友時 P2P 交換）
}

export interface Message {
  id: string;
  senderId: string;
  content: string;
  timestamp: number;
  type: 'text' | 'image' | 'file' | 'voice';
  isRead: boolean;
  isBurned: boolean;
  ttl?: number; // Time to live in seconds
  encrypted?: boolean; // 是否為加密訊息
  isLoading?: boolean; // 是否為載入中狀態（顯示轉圈動畫）
  /** 視圖群組：此訊息屬於哪些群組（可同時屬於多個群組） */
  groupIds?: string[];
  /** 訊息的對話對象公鑰（用於視圖群組的訊息路由） */
  recipientPubkey?: string;
  /** L2 風險評估結果 */
  riskResult?: L2Result;
  /** 語音訊息元資料 (type: 'voice' 時使用) */
  voiceData?: {
    /** 語音時長（秒） */
    duration: number;
    /** MIME 類型 (audio/webm, audio/mp4 等) */
    mimeType?: string;
    /** 語音轉文字結果（content 為顯示文字，transcript 為原始辨識結果） */
    transcript?: string;
    /** 波形數據（用於顯示波形動畫，可選） */
    waveform?: number[];
  };
  /** 檔案訊息元資料 (type: 'file' 時使用) */
  fileData?: {
    /** 檔案名稱 */
    name: string;
    /** MIME 類型 */
    mimeType: string;
    /** 檔案大小 (bytes) */
    size: number;
    /** 圖片/檔案說明文字 */
    caption?: string;
  };
}

export interface ChatRoom {
  friendId: string;
  messages: Message[];
}

/** 加密訊息信封 */
export interface EncryptedEnvelope {
  senderPublicKey: string;
  recipientPublicKey: string;
  ciphertext: string; // Base64
  nonce: string; // Base64
  timestamp: number;
  messageId: string;
}

// ============================================
// 群組相關類型
// ============================================

/** 群組成員角色 */
export type GroupRole = 'admin' | 'member';

/** 群組成員 */
export interface GroupMember {
  publicKey: string;
  nickname?: string;
  role: GroupRole;
  joinedAt: number;
  isOnline?: boolean;
}

/** 群組類型 */
export type GroupType = 'normal' | 'guardian';

/** 群組 */
export interface Group {
  id: string;
  name: string;
  avatar?: string; // emoji or URL
  members: GroupMember[];
  createdAt: number;
  createdBy: string; // 創建者公鑰
  updatedAt: number;
  lastMessage?: string;
  lastMessageTime?: number;
  unreadCount: number;
  // ADR-016: 巢狀群組已移除（parentGroupId / childGroupIds 不再使用）
  /** 群組類型：normal=一般群組, guardian=守護群組 */
  groupType?: GroupType;
  /** 守護群組設定 (僅 groupType='guardian' 時有效) */
  guardianSettings?: GuardianGroupSettings;
}

// 從 guardianGroup.ts 導入 (避免循環引用，這裡定義簡化版)
/** 守護群組設定 */
export interface GuardianGroupSettings {
  type: 'guardian';
  checkIn: {
    enabled: boolean;
    frequency: 'daily' | 'every_2_days' | 'weekly';
    notifyTime: string;
    timezone?: string;
    responseDeadline: number;
    customMessage?: string;
  };
  protection: {
    riskAlert: boolean;
    paymentAlert: boolean;
    linkAlert: boolean;
    riskThreshold: number;
  };
}

/** 群組訊息（擴展 Message） */
export interface GroupMessage extends Message {
  groupId: string;
  senderPublicKey: string;
  senderName?: string; // 發送者顯示名稱
}

/** 群組邀請 */
export interface GroupInvite {
  groupId: string;
  groupName: string;
  inviterPublicKey: string;
  inviterName?: string;
  timestamp: number;
  expiresAt: number;
}

/** 群組常數 (ADR-016) */
export const GROUP_CONSTANTS = {
  /** 群組最大人數 */
  MAX_MEMBERS: 50,
  /** 語音/視訊通話最大人數（WebRTC Media Stream 全網狀硬上限） */
  MAX_CALL_MEMBERS: 8,
  /** 群組名稱最大長度 */
  MAX_NAME_LENGTH: 50,
  /** 邀請過期時間（24 小時） */
  INVITE_EXPIRY_MS: 24 * 60 * 60 * 1000,
  /** 每群離線佇列上限 */
  OFFLINE_QUEUE_LIMIT: 500,
  /** 舊 Group Key 保留天數 */
  KEY_RETENTION_DAYS: 30,
  /** Key 輪換過渡期雙發時長（小時） */
  KEY_TRANSITION_HOURS: 72,
  /** DataChannel 閒置超時（毫秒，5 分鐘） */
  IDLE_TIMEOUT_MS: 300_000,
} as const;

// ============================================
// AegisTalk 風險評估類型
// ============================================

/** 風險等級 */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** 風險動作建議 */
export type RiskAction = 'allow' | 'warn' | 'block' | 'alert';

/** 觸發的規則 */
export interface TriggeredRule {
  id: string;
  name: string;
  category: string;
  severity: RiskLevel;
  description?: string;
}

/** L2 規則引擎結果 */
export interface L2Result {
  riskLevel: RiskLevel;
  riskScore: number;
  action: RiskAction;
  triggeredRules: TriggeredRule[];
  warnings: string[];
}

/** 風險評估結果 */
export interface RiskResult {
  riskLevel: RiskLevel;
  riskScore: number;
  action: RiskAction;
  warnings: string[];
  triggeredRules: TriggeredRule[];
  l2Result?: L2Result;
}

/** 語音風險關鍵詞 */
export interface VoiceRiskKeyword {
  keyword: string;
  category: string;
  score: number;
}

/** 語音風險結果 */
export interface VoiceRiskResult {
  riskScore: number;
  matchedKeywords: VoiceRiskKeyword[];
  riskCategories: string[];
  shouldAlert: boolean;
}

/** 26 維特徵向量 */
export interface FeatureVector {
  // 訊息特徵 (8 維)
  avgMsgLength: number;
  msgFrequencyPerHour: number;
  initiationRatio: number;
  avgReplyDelay: number;
  replyDelayCv: number;
  consecutiveMsgRatio: number;
  emojiRatio: number;
  questionRatio: number;

  // 內容風險特徵 (6 維)
  urlFrequency: number;
  shortUrlRatio: number;
  moneyWordFrequency: number;
  urgencyWordFrequency: number;
  copyPasteScore: number;
  sensitiveInfoRequestFreq: number;

  // 時間特徵 (4 維)
  lateNightRatio: number;
  timeEntropy: number;
  relationshipDays: number;
  timeToMoneyTalk: number;

  // 語音通話特徵 (4 維)
  callFrequencyPerWeek: number;
  avgCallDuration: number;
  missedCallRatio: number;
  voiceMsgRatio: number;

  // 語音風險特徵 (4 維)
  voiceAvgRiskScore: number;
  voiceMaxRiskScore: number;
  voiceHighRiskRatio: number;
  voiceRiskCategoryDiversity: number;
}

// ============================================
// L3 行為 AI 類型
// ============================================

/** 模型狀態 */
export type ModelState =
  | { type: 'cold_start'; samples_collected: number; samples_needed: number }
  | { type: 'training' }
  | { type: 'ready' }
  | { type: 'needs_retrain' };

/** L3 行為 AI 評估結果 */
export interface L3Result {
  /** 異常分數 (0-100) */
  anomalyScore: number;
  /** 是否異常 */
  isAnomaly: boolean;
  /** 信心度 (0-100) */
  confidence: number;
  /** 模型狀態 */
  modelState: ModelState;
  /** 異常原因 */
  reasons: string[];
  /** 威脅等級 */
  threatLevel: 'Low' | 'Medium' | 'High' | 'Unknown';
}

/** 行為 AI 統計 */
export interface BehaviorAIStats {
  contactModelCount: number;
  globalModelReady: boolean;
  globalSampleCount: number;
}

// ============================================
// VPS 同步類型
// ============================================

/** 同步進度 */
export interface SyncProgress {
  type: 'threats' | 'safelists' | 'yaml_rules';
  current: number;
  total: number;
  percent: number;
}

/** 同步元數據 */
export interface SyncMetadata {
  threats: {
    total: number;
    lastSync: string | null;
    lastUpdate: string | null;
  };
  safelists: {
    total: number;
    lastSync: string | null;
    lastUpdate: string | null;
  };
  yamlRules: {
    total: number;
    lastSync: string | null;
  };
}

// ============================================
// guardianGroup 類型 — AegisTrans deprecated (AegisGuard 守護群組概念)
// ============================================
// (moved to _deprecated/services/guardianGroup.ts)
