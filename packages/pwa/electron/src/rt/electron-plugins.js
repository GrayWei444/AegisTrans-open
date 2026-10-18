/* eslint-disable @typescript-eslint/no-var-requires */
//
// Capacitor SQLite 在 Electron 不註冊 native plugin — renderer 跑 Chromium,
// Capacitor.isNativePlatform() 在 electron 回 false,services/database.ts 走
// web 路徑(jeep-sqlite + IndexedDB),不呼叫任何 native CapacitorSQLite method。
// 註冊 sqlite native plugin 反而會把 better-sqlite3-multiple-ciphers + node-fetch
// + jszip 整套 native build 鏈拉進來,Python 3.13 拿掉 distutils 後 node-gyp 9.x
// 直接撞 ModuleNotFoundError,不值得。
//
// AegisDisplay Capacitor Electron plugin — bridges renderer to native macOS
// virtual display helper (CGVirtualDisplayCreate via mac/AegisDisplayHelper).
// Plugin name MUST match `registerPlugin('AegisDisplay', ...)` in
// packages/aegis-display/src/index.ts (i.e. the exported class name 'AegisDisplay').
//
// Resolution: package.json deps `@aegisrd/capacitor-aegisdisplay-electron` →
// `file:../../aegis-display/electron`. After `npm install`, npm creates a symlink
// inside `node_modules/`, which works both in dev (electron --inspect ./) and
// inside the packaged .app (electron-builder follows the symlink).
//
// NOTE: `npx cap sync electron` regenerates this file; if it strips the line below,
// re-add it manually until @capacitor-community/electron auto-discovery picks up
// our `capacitor.electron.src` field in packages/aegis-display/package.json.
const AegisDisplay = require('@aegisrd/capacitor-aegisdisplay-electron');

module.exports = {
  AegisDisplay,
}