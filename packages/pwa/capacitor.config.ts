import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aegisrd.aegistrans',
  appName: 'AegisTrans',
  webDir: 'dist',
  loggingBehavior: 'production',

  server: {
    androidScheme: 'https',
    iosScheme: 'https',
    allowNavigation: [
      'https://api.aegisrd.com',
      'https://mqtt.aegisrd.com',
      'https://trans.aegisrd.com',
    ],
  },

  android: {
    allowMixedContent: false,
    backgroundColor: '#0d1b2a',
  },

  ios: {
    backgroundColor: '#0d1b2a',
    contentInset: 'automatic',
    scrollEnabled: true,
  },

  plugins: {
    Filesystem: {
      storageDescription: 'AegisTrans 需要存取儲存空間以儲存接收的檔案',
    },
    Keyboard: {
      // 'native'：鍵盤彈出時縮整個 WebView frame，讓 100vh(h-screen/min-h-screen) 跟著縮，
      // flex-column 底部的輸入框自動被推到鍵盤上方。之前用 'body' 只縮 <body>，但 layout 用
      // 的是 vh 單位(不隨 body 縮)→ 輸入框留在鍵盤底下被遮(註冊/登入/聊天都中招)。
      resize: 'native',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: true,
    },
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#0d1b2a',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      androidIsEncryption: false,
    },
  },
};

export default config;
