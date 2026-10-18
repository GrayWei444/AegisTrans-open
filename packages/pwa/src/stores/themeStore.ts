/**
 * Theme Store — dark / light / system
 *
 * 抄自 AegisTalk packages/pwa/src/stores/themeStore.ts，
 * key 改成 aegistrans_theme 避免跟 AegisTalk 互踩。
 *
 * 套用 .dark / .light class 到 <html>，配合 tailwind.config.js darkMode='class'
 * 跟 index.css 內 :root / .dark CSS variables。
 */

import { create } from 'zustand';
import * as db from '../services/database';
import { devLog } from '../utils/devLog';

export type ThemeMode = 'dark' | 'light' | 'system';

const THEME_STORAGE_KEY = 'aegistrans_theme';

interface ThemeState {
  mode: ThemeMode;
  effectiveTheme: 'dark' | 'light';
  setMode: (mode: ThemeMode) => void;
  loadFromStorage: () => Promise<void>;
}

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

function getEffectiveTheme(mode: ThemeMode): 'dark' | 'light' {
  return mode === 'system' ? getSystemTheme() : mode;
}

function loadTheme(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved && ['dark', 'light', 'system'].includes(saved)) {
      return saved as ThemeMode;
    }
  } catch (e) {
    console.error('[themeStore] Failed to load theme:', e);
  }
  // AegisTrans 目前 UI 是 dark-first 寫死的，預設 dark 比 system 安全
  return 'dark';
}

function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (e) {
    console.error('[themeStore] Failed to save theme:', e);
  }
  db.setSetting(THEME_STORAGE_KEY, mode).catch(() => {});
}

function applyTheme(theme: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }
  devLog('[themeStore] Applied theme:', theme);
}

export const useThemeStore = create<ThemeState>((set) => {
  const initialMode = loadTheme();
  const initialEffective = getEffectiveTheme(initialMode);
  applyTheme(initialEffective);

  return {
    mode: initialMode,
    effectiveTheme: initialEffective,

    setMode: (mode: ThemeMode) => {
      const effective = getEffectiveTheme(mode);
      saveTheme(mode);
      applyTheme(effective);
      set({ mode, effectiveTheme: effective });
      devLog('[themeStore] Theme changed to:', mode, '(effective:', effective + ')');
    },

    loadFromStorage: async () => {
      try {
        await db.migrateFromLocalStorage(THEME_STORAGE_KEY);
        const saved = await db.getSetting(THEME_STORAGE_KEY);
        if (saved && ['dark', 'light', 'system'].includes(saved)) {
          const mode = saved as ThemeMode;
          const effective = getEffectiveTheme(mode);
          applyTheme(effective);
          set({ mode, effectiveTheme: effective });
        }
      } catch {
        const mode = loadTheme();
        const effective = getEffectiveTheme(mode);
        applyTheme(effective);
        set({ mode, effectiveTheme: effective });
      }
    },
  };
});

if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const state = useThemeStore.getState();
    if (state.mode === 'system') {
      const effective = e.matches ? 'dark' : 'light';
      applyTheme(effective);
      useThemeStore.setState({ effectiveTheme: effective });
    }
  });
}

export function useTheme() {
  return useThemeStore((state) => state.effectiveTheme);
}

export function useThemeMode() {
  return useThemeStore((state) => state.mode);
}
