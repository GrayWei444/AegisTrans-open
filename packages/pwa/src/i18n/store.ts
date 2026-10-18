/**
 * Language Store — 語言管理
 *
 * 鏡像 themeStore.ts：localStorage + IndexedDB 雙寫。
 * AegisTrans 不做推播通知，所以拿掉 syncNotificationStrings。
 */

import { create } from 'zustand';
import * as db from '../services/database';
import { devLog } from '../utils/devLog';
import type { Language } from './types';

const LANGUAGE_STORAGE_KEY = 'aegistrans_language';
const VALID_LANGUAGES: readonly string[] = ['zh-TW', 'zh-CN', 'en', 'ja', 'ko'];

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
  loadFromStorage: () => Promise<void>;
}

function loadLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved && VALID_LANGUAGES.includes(saved)) {
      return saved as Language;
    }
  } catch (e) {
    console.error('[languageStore] Failed to load language:', e);
  }
  return 'zh-TW';
}

function saveLanguage(lang: Language): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch (e) {
    console.error('[languageStore] Failed to save language:', e);
  }
  db.setSetting(LANGUAGE_STORAGE_KEY, lang).catch(() => {});
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: loadLanguage(),

  setLanguage: (lang: Language) => {
    saveLanguage(lang);
    set({ language: lang });
    devLog('[languageStore] Language changed to:', lang);
  },

  loadFromStorage: async () => {
    try {
      await db.migrateFromLocalStorage(LANGUAGE_STORAGE_KEY);
      const saved = await db.getSetting(LANGUAGE_STORAGE_KEY);
      if (saved && VALID_LANGUAGES.includes(saved)) {
        set({ language: saved as Language });
      }
    } catch {
      const lang = loadLanguage();
      set({ language: lang });
    }
  },
}));
