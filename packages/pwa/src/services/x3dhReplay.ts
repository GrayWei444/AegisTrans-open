/**
 * 已接受過的 X3DH_INIT（傳輸統一 X6）。
 *
 * useCrypto.acceptSession 判斷「同一封 INIT 重投遞」只靠記憶體裡的 acceptedEphemeralsRef。App 重啟後
 * （session 已從 DB 還原、記憶體紀錄沒了）同一封 INIT 再到一次（broker QoS1 重投、被殺前沒送出 PUBACK）
 * 就走 REPLACING／forceReset：把正常的 session 拆掉重建 Bob；OTP 已用掉時還會建出對不上的 session
 * → 對方下一則 aead → 又一輪修復。
 *
 * 現在：devicePairing 在交給 acceptSession 之前先查「這把 ephemeral 是否已接受過」，紀錄存 localStorage、
 * 跨重啟有效。保存 48h：INIT 的新鮮度與 broker session 都是 24h，更舊的重播會被 validateMessage 擋掉。
 * 紀錄綁本機帳號身分（identity pubkey；換帳號會換身分，且 accountWipe 會清掉）。ephemeral 是公鑰，不是秘密。
 */
const KEY = 'aegistrans_x3dh_accepted_v1';
const TTL_MS = 48 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
type Entry = { owner: string; peer: string; eph: string; at: number };

function read(): Entry[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    const now = Date.now();
    return Array.isArray(list)
      ? list.filter((e: Entry) => e && typeof e.owner === 'string' && typeof e.peer === 'string'
        && typeof e.eph === 'string' && typeof e.at === 'number' && now - e.at < TTL_MS)
      : [];
  } catch { return []; }
}

export function wasInitAccepted(owner: string, peer: string, eph: unknown): boolean {
  if (!owner || !peer || typeof eph !== 'string' || !eph) return false;
  return read().some((e) => e.owner === owner && e.peer === peer && e.eph === eph);
}

export function rememberAcceptedInit(owner: string, peer: string, eph: unknown): void {
  if (!owner || !peer || typeof eph !== 'string' || !eph) return;
  const rest = read().filter((e) => !(e.owner === owner && e.peer === peer && e.eph === eph));
  try { localStorage.setItem(KEY, JSON.stringify([...rest, { owner, peer, eph, at: Date.now() }].slice(-MAX_ENTRIES))); }
  catch { /* 無 storage：退回只靠 useCrypto 的記憶體去重 */ }
}
