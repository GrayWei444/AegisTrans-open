/**
 * 換伺服器：先好好斷線、登出，再存新選擇、重新載入。
 *
 * - 登出只清 session、裝置 id 與加密金鑰快取；本機訊息不在這裡刪。本機資料的擁有者記錄綁著伺服器
 *   （useAuth 的 aegistrans_owner_server），所以之後在另一台伺服器登入任何帳號，都會被當成「換帳號」，
 *   照既有 CR-02 規則（失敗即中止）先清掉前一個帳號的本機資料；換回原伺服器、登入原帳號則保留。
 * - 等待中的 email 登入連結屬於舊伺服器，一併清掉。
 * - 重新載入讓所有模組（API 位址、MQTT broker）從新設定重新開始，不會有半新半舊的連線。
 */
import { signOut, clearPendingRequest } from './auth';
import { mqttService } from './mqtt';
import { saveCustomServer, clearCustomServer, type CustomServer } from './serverChoice';

const SHUTDOWN_TIMEOUT_MS = 1500;

/** next = null 表示改回預設（官方）伺服器。寫入失敗會 throw，此時什麼都還沒改。 */
export async function switchServer(next: CustomServer | null): Promise<void> {
  // 先確認能寫入（私密模式／空間滿時 throw），避免登出了卻沒換成
  if (next) saveCustomServer(next);
  else clearCustomServer();

  try {
    await mqttService.gracefulShutdown(SHUTDOWN_TIMEOUT_MS);
  } catch {
    /* 斷線失敗不擋換伺服器：重新載入一樣會關掉連線 */
  }
  try {
    mqttService.disconnect();
  } catch {
    /* ignore */
  }
  signOut();
  try {
    clearPendingRequest();
  } catch {
    /* ignore */
  }
  window.location.reload();
}
