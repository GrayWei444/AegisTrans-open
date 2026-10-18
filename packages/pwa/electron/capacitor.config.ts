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
      resize: 'body',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: false,
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
