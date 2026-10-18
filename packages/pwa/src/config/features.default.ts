/**
 * AegisTalk 預設功能配置
 *
 * Phase 13: 白標抽象架構
 *
 * 這是 AegisTalk 的預設功能開關設定。
 * 白標客戶可以透過覆寫這些值來啟用/停用特定功能。
 */

import type { FeaturesConfig } from './types';

/**
 * AegisTalk 預設功能配置 (Enterprise 全功能)
 */
export const defaultFeaturesConfig: FeaturesConfig = {
  // 訊息功能
  messaging: {
    enabled: true, // 必須開啟
    voiceMessage: true,
    videoCall: true,
    voiceCall: true,
    groupCall: true,
    fileSharing: true,
    groupFileSharing: true,
    e2eEncryption: true, // 必須開啟
    groupChat: true,
  },

  // 防詐功能
  aegisProtection: {
    l1SemanticAI: true,
    l2RuleEngine: true,
    l3BehaviorAI: true,
    voiceRiskAnalysis: true,
    trustScore: true,
    // Phase 16: 暫時關閉以便自動化測試，生產環境應設為 true
    pinBehaviorFingerprint: false,
    // Phase 26: 臉部辨識（預設開啟，無相機設備自動降級）
    faceRecognition: true,
    deviceFingerprint: true,
    sameSourceDetection: true,
    usbDebuggingCheck: true,
  },

  // 附加功能
  addons: {
    aegisPay: false, // Phase 17 待實作
    aegisGuard: true, // AegisGuard 防護模組
    pushNotifications: false,
    devTools: true, // 開發階段開啟
    socialRecovery: true,
    deviceTransfer: true,
    weatherWidget: false, // Mist 遺留功能，預設關閉
    cloudBackup: true, // Phase 28 雲端備份
  },

  // 授權
  license: {
    type: 'enterprise',
    features: [
      'messaging.*',
      'aegisProtection.*',
      'addons.devTools',
      'addons.socialRecovery',
      'addons.deviceTransfer',
    ],
  },
};

/**
 * 免費版功能配置
 */
export const freeFeaturesConfig: FeaturesConfig = {
  messaging: {
    enabled: true,
    voiceMessage: true,
    videoCall: false, // 免費版不支援
    voiceCall: true,
    groupCall: false, // 免費版不支援
    fileSharing: true,
    groupFileSharing: false, // 免費版不支援
    e2eEncryption: true,
    groupChat: true,
  },

  aegisProtection: {
    l1SemanticAI: false, // 免費版不支援
    l2RuleEngine: true,
    l3BehaviorAI: false, // 免費版不支援
    voiceRiskAnalysis: false, // 免費版不支援
    trustScore: true,
    pinBehaviorFingerprint: true,
    faceRecognition: true,
    deviceFingerprint: true,
    sameSourceDetection: true,
    usbDebuggingCheck: true,
  },

  addons: {
    aegisPay: false,
    aegisGuard: false, // 免費版不支援
    pushNotifications: false,
    devTools: false,
    socialRecovery: true,
    deviceTransfer: true,
    weatherWidget: false,
    cloudBackup: true,
  },

  license: {
    type: 'free',
    features: [
      'messaging.enabled',
      'messaging.voiceMessage',
      'messaging.voiceCall',
      'messaging.fileSharing',
      'messaging.e2eEncryption',
      'messaging.groupChat',
      'aegisProtection.l2RuleEngine',
      'aegisProtection.trustScore',
      'aegisProtection.pinBehaviorFingerprint',
      'aegisProtection.faceRecognition',
      'aegisProtection.deviceFingerprint',
      'aegisProtection.sameSourceDetection',
      'addons.socialRecovery',
      'addons.deviceTransfer',
    ],
  },
};

/**
 * Pro 版功能配置
 */
export const proFeaturesConfig: FeaturesConfig = {
  messaging: {
    enabled: true,
    voiceMessage: true,
    videoCall: true,
    voiceCall: true,
    groupCall: true,
    fileSharing: true,
    groupFileSharing: true,
    e2eEncryption: true,
    groupChat: true,
  },

  aegisProtection: {
    l1SemanticAI: false, // Pro 版不支援
    l2RuleEngine: true,
    l3BehaviorAI: true,
    voiceRiskAnalysis: true,
    trustScore: true,
    pinBehaviorFingerprint: true,
    faceRecognition: true,
    deviceFingerprint: true,
    sameSourceDetection: true,
    usbDebuggingCheck: true,
  },

  addons: {
    aegisPay: false,
    aegisGuard: true, // Pro 版支援
    pushNotifications: false,
    devTools: false,
    socialRecovery: true,
    deviceTransfer: true,
    weatherWidget: false,
    cloudBackup: true,
  },

  license: {
    type: 'pro',
    features: [
      'messaging.*',
      'aegisProtection.l2RuleEngine',
      'aegisProtection.l3BehaviorAI',
      'aegisProtection.voiceRiskAnalysis',
      'aegisProtection.trustScore',
      'aegisProtection.pinBehaviorFingerprint',
      'aegisProtection.faceRecognition',
      'aegisProtection.deviceFingerprint',
      'aegisProtection.sameSourceDetection',
      'addons.socialRecovery',
      'addons.deviceTransfer',
    ],
  },
};

/**
 * 根據授權類型取得功能配置
 */
export function getFeaturesConfigByLicense(
  licenseType: 'free' | 'pro' | 'enterprise'
): FeaturesConfig {
  switch (licenseType) {
    case 'free':
      return freeFeaturesConfig;
    case 'pro':
      return proFeaturesConfig;
    case 'enterprise':
    default:
      return defaultFeaturesConfig;
  }
}

export default defaultFeaturesConfig;
