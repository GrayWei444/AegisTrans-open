/**
 * ICE Servers 設定
 *
 * 架構原則：所有訊息內容不經過任何伺服器
 * - STUN：只用於發現公網 IP（不轉發資料）
 * - TURN：禁用（資料會經過 TURN 伺服器，違反隱私原則）
 * - 連線方式：LAN 直連 / IPv6 / STUN NAT 穿越
 */

import { getActiveServer } from './serverChoice';

/** 伺服器沒提供 STUN 時的公共備用（只做 NAT 探測，不轉送資料） */
const PUBLIC_STUN_FALLBACK = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/**
 * 只返回 STUN 伺服器（無 TURN）
 *
 * 連線優先順序：
 * 1. host（LAN 直連 / IPv6）
 * 2. srflx（STUN NAT 穿越）
 * 3. 無法連線 → 訊息佇列等待下次直連機會
 */
export function getIceServers(): RTCIceServer[] {
  const server = getActiveServer();
  const servers: RTCIceServer[] = [];

  // 自架 STUN（從伺服器的 turn: 位址衍生 stun: —— 只拿 host:port，不加 TURN）
  if (server.turnUrl) {
    const match = server.turnUrl.match(/^turns?:([^?]+)/);
    if (match) {
      servers.push({ urls: `stun:${match[1]}` });
    }
  }

  // 伺服器提供的 STUN；沒提供就用公共備用
  const stun = server.stunUrls && server.stunUrls.length ? server.stunUrls : PUBLIC_STUN_FALLBACK;
  for (const urls of stun) servers.push({ urls });

  // ❌ 不加 TURN — 訊息內容不可經過任何伺服器

  return servers;
}
