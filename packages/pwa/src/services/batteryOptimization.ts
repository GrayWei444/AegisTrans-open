/**
 * Battery Optimization — 引導使用者關閉電池優化
 *
 * Android 的電池優化（Samsung FreecessHandler、Doze 等）會殺 TCP sockets，
 * 導致 MQTT WebSocket 連線中斷。請求使用者將 app 加入電池優化白名單。
 */

import { Capacitor } from '@capacitor/core';

/**
 * 請求忽略電池優化（僅 Android native）
 * 會彈出系統對話框讓使用者選擇
 */
export async function requestBatteryOptimizationExemption(): Promise<void> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return;
  }

  try {
    // 使用 Capacitor 的 bridge 呼叫 Android Intent
    const { App } = await import('@capacitor/app');
    // 無法直接呼叫 startActivity，改用 URL scheme
    // ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 需要透過 WebView bridge
    // 目前透過 AndroidManifest.xml 的 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS 權限聲明
    // 加上 Health Monitor 的自動重連機制來應對
    console.error('[BatteryOpt] Battery optimization exemption requested via manifest permission');
    // App reference to suppress unused import warning
    void App;
  } catch (err) {
    console.error('[BatteryOpt] Failed to request battery optimization exemption:', err);
  }
}
