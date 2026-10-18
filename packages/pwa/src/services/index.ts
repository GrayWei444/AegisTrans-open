/**
 * Services - 業務邏輯服務層
 *
 * AegisTrans note: 從 AegisTalk 縮減而來。
 * 移到 _deprecated/ 的 services（aegis 規則引擎、語音分析、verification 邀請、vpsSync）
 * 不再 re-export。需要時再個別 import。
 */

// 加密
export * from './crypto';
export { default as crypto } from './crypto';

// MQTT
export * from './mqtt';
export { default as mqtt } from './mqtt';

// WebRTC
export * from './webrtc';
export { default as webrtc } from './webrtc';
