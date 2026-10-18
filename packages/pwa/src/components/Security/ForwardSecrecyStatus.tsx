/**
 * Forward Secrecy Status — 前向保密狀態指示器
 *
 * 來源：抄 AegisTalk packages/pwa/src/components/Security/ForwardSecrecyStatus.tsx，
 * 改用 AegisTrans 語意 tokens（bg-surface-* / text-on-surface-* / mist-500）以對齊
 * dark/light theme（避免 fork 配色 hardcoded 的 commit 5fe0bfe 教訓）。
 *
 * 顯示 preKeyRotationService.getStatus()：
 *   - SignedPreKey 年齡 / 是否需要輪換
 *   - OneTimePreKey 可用量 / 是否需要補充
 *   - 整體健康度
 *   - 手動 forceRotate / forceReplenish 按鈕
 *
 * 注意：服務跟實際 X3DH 用的是平行 store；UI 顯示的是「服務視角」，
 * X3DH 真的在用的 keys 由 useCrypto 內部 state 管理（OTP 自動補充已加）。
 * 完整深度整合屬 v1.x 後續工作。
 */

import { useState, useEffect, useCallback } from 'react';
import { preKeyRotationService, type PreKeyStatus } from '../../services/preKeyRotation';

interface ForwardSecrecyStatusProps {
  compact?: boolean;
}

export function ForwardSecrecyStatus({ compact = false }: ForwardSecrecyStatusProps) {
  const [status, setStatus] = useState<PreKeyStatus | null>(null);
  const [isRotating, setIsRotating] = useState(false);
  const [isReplenishing, setIsReplenishing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const loadStatus = useCallback(() => {
    setStatus(preKeyRotationService.getStatus());
    setLastUpdate(new Date());
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 30_000);
    const unsubscribe = preKeyRotationService.onRotation(loadStatus);
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [loadStatus]);

  const handleRotateSignedPreKey = async () => {
    setIsRotating(true);
    try {
      await preKeyRotationService.forceRotateSignedPreKey();
      loadStatus();
    } catch (err) {
      console.error('[ForwardSecrecyStatus] forceRotate failed:', err);
    } finally {
      setIsRotating(false);
    }
  };

  const handleReplenishOneTimePreKeys = async () => {
    setIsReplenishing(true);
    try {
      await preKeyRotationService.forceReplenishOneTimePreKeys();
      loadStatus();
    } catch (err) {
      console.error('[ForwardSecrecyStatus] forceReplenish failed:', err);
    } finally {
      setIsReplenishing(false);
    }
  };

  if (!status) {
    return compact ? null : (
      <div className="p-4 text-sm text-on-surface-tertiary">載入中…</div>
    );
  }

  const config = preKeyRotationService.getConfig();

  const healthClass = (healthy: boolean) =>
    healthy ? 'text-green-500' : 'text-yellow-500';
  const healthIcon = (healthy: boolean) => (healthy ? '✓' : '⚠');

  // Compact 模式：給 SettingsPage 嵌入用
  if (compact) {
    return (
      <div className="space-y-3">
        {/* 整體狀態列 */}
        <div className="flex items-center justify-between">
          <span className="text-on-surface-primary text-sm">整體加密健康度</span>
          <span className={`text-xs ${healthClass(status.healthy)}`}>
            {healthIcon(status.healthy)} {status.healthy ? '良好' : '需注意'}
            {lastUpdate && (
              <span className="ml-2 text-on-surface-tertiary">
                ({lastUpdate.toLocaleTimeString()})
              </span>
            )}
          </span>
        </div>

        {/* SignedPreKey */}
        <div className="bg-surface-tertiary rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-on-surface-secondary">簽署預金鑰 (SignedPreKey)</span>
            <span className={`text-xs ${healthClass(!status.signedPreKey.needsRotation)}`}>
              {healthIcon(!status.signedPreKey.needsRotation)} #{status.signedPreKey.id}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-on-surface-tertiary">年齡</span>
            <span className={healthClass(!status.signedPreKey.needsRotation)}>
              {status.signedPreKey.ageInDays} / {config.SIGNED_PREKEY_ROTATION_DAYS} 天
              {status.signedPreKey.needsRotation && '（需輪換）'}
            </span>
          </div>
          <div className="mt-2 h-1.5 bg-[var(--surface-border)] rounded-full overflow-hidden">
            <div
              className={`h-full ${status.signedPreKey.needsRotation ? 'bg-yellow-500' : 'bg-green-500'}`}
              style={{
                width: `${Math.min(100, (status.signedPreKey.ageInDays / config.SIGNED_PREKEY_ROTATION_DAYS) * 100)}%`,
              }}
            />
          </div>
          <button
            type="button"
            onClick={handleRotateSignedPreKey}
            disabled={isRotating}
            className="mt-3 w-full py-1.5 text-xs bg-mist-500 hover:bg-mist-600 disabled:opacity-50 text-white rounded transition-colors"
          >
            {isRotating ? '輪換中…' : '手動輪換'}
          </button>
        </div>

        {/* OneTimePreKey */}
        <div className="bg-surface-tertiary rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-on-surface-secondary">一次性預金鑰 (OneTimePreKey)</span>
            <span className={`text-xs ${healthClass(!status.oneTimePreKeys.needsReplenishment)}`}>
              {healthIcon(!status.oneTimePreKeys.needsReplenishment)} {status.oneTimePreKeys.available} 可用
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="text-on-surface-tertiary">
              可用 <span className={`block font-medium ${healthClass(!status.oneTimePreKeys.needsReplenishment)}`}>{status.oneTimePreKeys.available}</span>
            </div>
            <div className="text-on-surface-tertiary">
              已用 <span className="block font-medium text-on-surface-primary">{status.oneTimePreKeys.used}</span>
            </div>
            <div className="text-on-surface-tertiary">
              閾值 <span className="block font-medium text-on-surface-primary">{status.oneTimePreKeys.threshold}</span>
            </div>
          </div>
          <div className="mt-2 h-1.5 bg-[var(--surface-border)] rounded-full overflow-hidden">
            <div
              className={`h-full ${status.oneTimePreKeys.needsReplenishment ? 'bg-yellow-500' : 'bg-green-500'}`}
              style={{
                width: `${Math.min(100, (status.oneTimePreKeys.available / (config.ONETIME_PREKEY_BATCH_SIZE * 2)) * 100)}%`,
              }}
            />
          </div>
          <button
            type="button"
            onClick={handleReplenishOneTimePreKeys}
            disabled={isReplenishing}
            className="mt-3 w-full py-1.5 text-xs bg-mist-500 hover:bg-mist-600 disabled:opacity-50 text-white rounded transition-colors"
          >
            {isReplenishing ? '補充中…' : '手動補充'}
          </button>
        </div>

        <p className="text-xs text-on-surface-tertiary leading-relaxed">
          前向保密確保即使長期金鑰外洩，過去訊息仍受保護。系統每 1 小時自動檢查、
          每 30 天輪換 SignedPreKey、OTP 低於 10 自動補滿。
        </p>
      </div>
    );
  }

  // 完整模式（modal-style，目前未使用，保留給未來頁面）
  return (
    <div className="bg-surface-secondary rounded-2xl p-4 space-y-4">
      <h2 className="text-base font-semibold text-on-surface-primary">前向保密狀態</h2>
      <ForwardSecrecyStatus compact />
    </div>
  );
}

export default ForwardSecrecyStatus;
