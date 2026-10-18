/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_MQTT_URL: string
  readonly VITE_TURN_URL: string
  // '1' 才開 debug/diagnostics 曝露（remoteDebugger + window.__aegis*）。dogfood/e2e build 設；release 不設。
  readonly VITE_DEBUG_TOOLS: string
  // 自架 build 的預設伺服器（見 .env.example；沒設 = 官方伺服器）
  readonly VITE_DEFAULT_API_URL?: string
  readonly VITE_DEFAULT_WEB_API_PATH?: string
  readonly VITE_DEFAULT_MQTT_URL?: string
  readonly VITE_DEFAULT_TURN_URL?: string
  readonly VITE_DEFAULT_WEB_URL?: string
  readonly VITE_DEFAULT_SERVER_NAME?: string
  readonly VITE_DEFAULT_PRIVACY_URL?: string
  readonly VITE_DEFAULT_TERMS_URL?: string
  readonly VITE_DEFAULT_SUPPORT_URL?: string
  // dogfood 遠端 log 端點（私有 deploy.private.env 提供；公開版沒有）
  readonly VITE_REMOTE_DEBUG_MQTT_URL?: string
  readonly VITE_REMOTE_DEBUG_TOKEN_URL?: string
  readonly VITE_REMOTE_DEBUG_SAME_ORIGIN_TOKEN_PATH?: string
  readonly VITE_REMOTE_DEBUG_SAME_ORIGIN_MATCH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// pdf.js legacy build 沒有同位的 .d.ts；型別沿用主套件宣告（runtime 走 legacy，型別走標準）。
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist'
}
