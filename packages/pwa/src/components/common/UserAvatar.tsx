/**
 * UserAvatar - 統一用戶頭像元件
 *
 * 所有用戶頭像的單一來源。
 * 顯示上傳圖片或預設 SVG 人形剪影。
 */

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/** 驗證狀態 → 外框顏色 */
type TrustStatus = 'verified' | 'unverified' | 'high-risk';

interface UserAvatarProps {
  /** 頭像值 (base64 / URL / 空字串或 emoji 顯示預設) */
  avatar?: string;
  /** 替代文字 */
  name?: string;
  /** 尺寸 */
  size?: AvatarSize;
  /** 額外 CSS 類別 (例如 ring / border) */
  className?: string;
  /** 驗證狀態（影響外框顏色） */
  trustStatus?: TrustStatus;
}

const SIZE_MAP: Record<AvatarSize, { container: string; icon: string }> = {
  xs:  { container: 'w-6 h-6',   icon: 'w-3.5 h-3.5' },
  sm:  { container: 'w-8 h-8',   icon: 'w-4 h-4' },
  md:  { container: 'w-10 h-10', icon: 'w-5 h-5' },
  lg:  { container: 'w-12 h-12', icon: 'w-6 h-6' },
  xl:  { container: 'w-16 h-16', icon: 'w-8 h-8' },
  '2xl': { container: 'w-24 h-24', icon: 'w-12 h-12' },
};

function isImageAvatar(avatar?: string): boolean {
  if (!avatar) return false;
  return avatar.startsWith('data:image') || avatar.startsWith('http');
}

const TRUST_RING: Record<TrustStatus, string> = {
  verified: 'ring-2 ring-emerald-400',
  unverified: 'ring-2 ring-yellow-400',
  'high-risk': 'ring-2 ring-red-500',
};


export function UserAvatar({ avatar, name, size = 'md', className = '', trustStatus }: UserAvatarProps) {
  const { container } = SIZE_MAP[size];
  const ring = trustStatus ? TRUST_RING[trustStatus] : '';

  if (isImageAvatar(avatar)) {
    return (
      <img
        src={avatar}
        alt={name || 'Avatar'}
        className={`${container} rounded-full object-cover ${ring} ${className}`}
      />
    );
  }

  // 無頭像 → 顯示通用人形剪影 + 驗證狀態外框
  return (
    <div className={`${container} rounded-full bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center ${ring} ${className}`}>
      <svg className={`${SIZE_MAP[size].icon} text-teal-500`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    </div>
  );
}
