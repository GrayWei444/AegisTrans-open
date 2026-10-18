/**
 * Build-time debug/diagnostics switch (CR-06 / H-07 hardening, 2026-06-24).
 *
 * 預設 **關**（release-safe / fail-closed）。只有 dogfood / e2e build 顯式設
 * `VITE_DEBUG_TOOLS=1` 時才開。`import.meta.env.VITE_DEBUG_TOOLS` 是 Vite build 期
 * 靜態替換 → release build 走 `if (false)` → 整段被 tree-shake 掉（remoteDebugger
 * 的 dynamic import、`window.__aegis*` test seams 都不會進 release bundle）。
 *
 * 開啟時暴露：行動端 remoteDebugger（console→MQTT 上傳）+ `window.__aegisDebug` /
 * `__aegisTierGate` / `__aegisStores`（e2e 用，會洩漏訊息存取 + 可改 Pro gate）。
 *
 * 用法：
 *   - dogfood / e2e build：`VITE_DEBUG_TOOLS=1 npm run build`
 *   - public release build：`npm run build`（預設關，乾淨）
 */
export const DEBUG_TOOLS: boolean = import.meta.env.VITE_DEBUG_TOOLS === '1';
