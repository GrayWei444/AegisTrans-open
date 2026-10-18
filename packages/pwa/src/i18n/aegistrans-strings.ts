/**
 * AegisTrans 專屬 i18n 字串補集
 *
 * 為什麼獨立檔案而不擴 global TranslationKeys schema？
 *   - global schema 有 1000+ AegisTalk 字串（聊天/通話/詐騙/守護等），AegisTrans 都用不到
 *   - 直接擴 schema 要動 5 個 locale 檔，雜訊大
 *   - 這份只放 AegisTrans 真正用得到的 UI 字串，5 種語言對照表
 *
 * 用法：
 *   import { aegisT } from '../i18n/aegistrans-strings';
 *   const { language } = useLanguage();
 *   <button>{aegisT(language, 'bottomNav.timeline')}</button>
 */

import type { Language } from './types';

type LangMap = Record<Language, string>;

const STRINGS = {
  // BottomNav 三個 tab
  'bottomNav.timeline':  { 'zh-TW': '對話',     'zh-CN': '对话',     en: 'Chat',     ja: 'チャット', ko: '대화' },
  'bottomNav.devices':   { 'zh-TW': '裝置',     'zh-CN': '设备',     en: 'Devices',  ja: 'デバイス', ko: '기기' },
  'bottomNav.settings':  { 'zh-TW': '設定',     'zh-CN': '设置',     en: 'Settings', ja: '設定',     ko: '설정' },

  // App.tsx header
  'app.signOut':         { 'zh-TW': '登出',     'zh-CN': '登出',     en: 'Sign out', ja: 'ログアウト', ko: '로그아웃' },
  'app.settings':        { 'zh-TW': '設定',     'zh-CN': '设置',     en: 'Settings', ja: '設定',     ko: '설정' },
  'app.backToMessages':  { 'zh-TW': '回到訊息', 'zh-CN': '返回消息', en: 'Back',     ja: '戻る',     ko: '뒤로' },
  'app.privacyPolicy':   { 'zh-TW': '隱私政策', 'zh-CN': '隐私政策', en: 'Privacy Policy', ja: 'プライバシーポリシー', ko: '개인정보 처리방침' },
  'app.termsOfService':  { 'zh-TW': '服務條款', 'zh-CN': '服务条款', en: 'Terms of Service', ja: '利用規約', ko: '서비스 약관' },
  'app.support':         { 'zh-TW': '支援', 'zh-CN': '支持', en: 'Support', ja: 'サポート', ko: '지원' },
  'app.deleteAccountWeb':{ 'zh-TW': '網頁版帳號刪除申請', 'zh-CN': '网页版账号删除申请', en: 'Web account deletion request', ja: 'ウェブでのアカウント削除申請', ko: '웹 계정 삭제 요청' },
  // 開機註冊裝置被 API 拒絕（重試不會好的 4xx）；後面接伺服器回的狀態與訊息
  'app.registerRejected':{ 'zh-TW': '這台裝置無法完成註冊。請稍後重新開啟 App；持續發生請聯絡支援。', 'zh-CN': '这台设备无法完成注册。请稍后重新打开 App；持续发生请联系支持。', en: 'This device could not be registered. Please reopen the app later; contact support if this keeps happening.', ja: 'このデバイスを登録できませんでした。しばらくしてからアプリを開き直してください。解決しない場合はサポートにお問い合わせください。', ko: '이 기기를 등록하지 못했습니다. 잠시 후 앱을 다시 열어 주세요. 계속 발생하면 지원팀에 문의하세요.' },

  // SettingsPage 裝置區
  'settings.refresh':    { 'zh-TW': '重新整理', 'zh-CN': '刷新',     en: 'Refresh',    ja: '更新',     ko: '새로고침' },
  'settings.refreshing': { 'zh-TW': '更新中…',  'zh-CN': '刷新中…',  en: 'Refreshing…', ja: '更新中…',  ko: '새로고침 중…' },

  // PasswordSection
  'password.title':              { 'zh-TW': '密碼登入',           'zh-CN': '密码登录',           en: 'Password login',          ja: 'パスワードログイン', ko: '비밀번호 로그인' },
  'password.checking':           { 'zh-TW': '查詢中…',            'zh-CN': '查询中…',            en: 'Checking…',               ja: '確認中…',          ko: '확인 중…' },
  'password.set':                { 'zh-TW': '✓ 已設定',           'zh-CN': '✓ 已设置',           en: '✓ Set',                   ja: '✓ 設定済み',       ko: '✓ 설정됨' },
  'password.notSet':             { 'zh-TW': '尚未設定',           'zh-CN': '未设置',             en: 'Not set',                 ja: '未設定',           ko: '미설정' },
  'password.hint':               { 'zh-TW': '設定密碼後，新裝置可直接用 email + password 登入，不用每次翻信。密碼只用來登入，不影響加密金鑰；忘記密碼可走 Email 連結重置。', 'zh-CN': '设置密码后，新设备可直接用 email + password 登录，无需每次翻邮件。', en: 'Once set, new devices can log in with email + password directly without checking emails each time.', ja: 'パスワード設定後、新しいデバイスはメール + パスワードで直接ログインできます。', ko: '비밀번호 설정 후 새 기기에서 이메일 + 비밀번호로 직접 로그인할 수 있습니다.' },
  'password.newPlaceholder':     { 'zh-TW': '新密碼（至少 8 字元）',     'zh-CN': '新密码（至少 8 字符）',     en: 'New password (≥ 8 chars)',     ja: '新しいパスワード（8文字以上）', ko: '새 비밀번호 (8자 이상)' },
  'password.setupPlaceholder':   { 'zh-TW': '設定密碼（至少 8 字元）',   'zh-CN': '设置密码（至少 8 字符）',   en: 'Set password (≥ 8 chars)',     ja: 'パスワード設定（8文字以上）',  ko: '비밀번호 설정 (8자 이상)' },
  'password.confirmPlaceholder': { 'zh-TW': '再輸入一次',           'zh-CN': '再输入一次',           en: 'Re-enter',                ja: 'もう一度',         ko: '다시 입력' },
  'password.tooShort':           { 'zh-TW': '密碼至少 8 字元',     'zh-CN': '密码至少 8 字符',     en: 'Password must be ≥ 8 chars', ja: 'パスワードは8文字以上',  ko: '비밀번호는 8자 이상' },
  'password.mismatch':           { 'zh-TW': '兩次密碼不一致',     'zh-CN': '两次密码不一致',     en: 'Passwords do not match',  ja: 'パスワードが一致しません', ko: '비밀번호가 일치하지 않음' },
  'password.processing':         { 'zh-TW': '處理中…',            'zh-CN': '处理中…',            en: 'Processing…',             ja: '処理中…',          ko: '처리 중…' },
  'password.updated':            { 'zh-TW': '密碼已更新',         'zh-CN': '密码已更新',         en: 'Password updated',        ja: 'パスワードを更新しました', ko: '비밀번호가 업데이트됨' },
  'password.created':            { 'zh-TW': '密碼已設定',         'zh-CN': '密码已设置',         en: 'Password set',            ja: 'パスワードを設定しました', ko: '비밀번호가 설정됨' },
  'password.setupFailed':        { 'zh-TW': '設定失敗，請稍後再試', 'zh-CN': '设置失败，请稍后再试', en: 'Setup failed, try again', ja: '設定に失敗しました',     ko: '설정 실패' },
  'password.changeBtn':          { 'zh-TW': '修改密碼',           'zh-CN': '修改密码',           en: 'Change password',         ja: 'パスワード変更',     ko: '비밀번호 변경' },
  'password.setBtn':             { 'zh-TW': '設定密碼',           'zh-CN': '设置密码',           en: 'Set password',            ja: 'パスワード設定',     ko: '비밀번호 설정' },
  'password.currentPlaceholder': { 'zh-TW': '目前密碼',           'zh-CN': '目前密码',           en: 'Current password',        ja: '現在のパスワード',   ko: '현재 비밀번호' },
  'password.currentRequired':    { 'zh-TW': '修改密碼必須輸入目前密碼',   'zh-CN': '修改密码必须输入目前密码',   en: 'Current password is required to change',   ja: 'パスワード変更には現在のパスワードが必要',   ko: '비밀번호 변경 시 현재 비밀번호가 필요합니다' },
  'password.currentWrong':       { 'zh-TW': '目前密碼錯誤',       'zh-CN': '目前密码错误',       en: 'Current password is incorrect', ja: '現在のパスワードが間違っています', ko: '현재 비밀번호가 올바르지 않습니다' },

  // Danger zone
  'danger.title':                { 'zh-TW': '危險區',             'zh-CN': '危险区',             en: 'Danger zone',             ja: '危険ゾーン',         ko: '위험 영역' },
  'danger.description':          { 'zh-TW': '刪除帳號將立即刪除所有 server 端 metadata（user / devices / magic tokens）。本機檔案不受影響（我們從來沒存你的檔案）。此操作不可恢復。', 'zh-CN': '删除账号将立即删除所有 server 端 metadata。本机文件不受影响。此操作不可恢复。', en: 'Deletes all server-side metadata (user / devices / magic tokens). Local files are not affected (we never stored them). Irreversible.', ja: 'サーバー側のメタデータ（ユーザー/デバイス/マジックトークン）をすべて削除します。ローカルファイルは影響を受けません。', ko: '서버 측 메타데이터를 모두 삭제합니다. 로컬 파일은 영향을 받지 않습니다.' },
  'danger.confirmText':          { 'zh-TW': '刪除帳號',           'zh-CN': '删除账号',           en: 'delete account',          ja: 'アカウント削除',     ko: '계정 삭제' },
  'danger.confirmPlaceholder':   { 'zh-TW': '輸入「刪除帳號」確認', 'zh-CN': '输入「删除账号」确认', en: 'Type "delete account"',  ja: '「アカウント削除」と入力', ko: '"계정 삭제" 입력' },
  'danger.deleteBtn':            { 'zh-TW': '永久刪除帳號',       'zh-CN': '永久删除账号',       en: 'Permanently delete account', ja: 'アカウントを完全に削除', ko: '계정 영구 삭제' },
  'danger.deleting':             { 'zh-TW': '刪除中…',            'zh-CN': '删除中…',            en: 'Deleting…',               ja: '削除中…',           ko: '삭제 중…' },
  'danger.confirmDialog':        { 'zh-TW': '最後確認：將永久刪除你的帳號 + 所有 server 端 metadata。\n本機資料（訊息、檔案）不會被刪除，需自行清除。\n\n繼續？', 'zh-CN': '最后确认：将永久删除你的账号。\n本机资料不会删除，需自行清除。\n\n继续？', en: 'Final confirm: this permanently deletes your account + all server-side metadata. Local data (messages, files) is NOT deleted; clear manually.\n\nProceed?', ja: '最終確認：アカウントとサーバー側メタデータをすべて削除します。\nローカルデータは削除されません。\n\n続行？', ko: '최종 확인: 계정 및 서버 메타데이터가 영구 삭제됩니다.\n로컬 데이터는 유지됩니다.\n\n계속?' },
  'danger.deleteFailed':         { 'zh-TW': '刪除失敗，請稍後再試', 'zh-CN': '删除失败，请稍后再试', en: 'Delete failed, try again', ja: '削除に失敗しました',   ko: '삭제 실패' },

  // ChatInput 錯誤訊息
  'chat.error.noPeer':       { 'zh-TW': '還沒有其他裝置上線，無法傳送。請先在另一台裝置同帳號登入。', 'zh-CN': '还没有其他设备上线，无法传送。请先在另一台设备同账号登录。', en: 'No other device online. Sign in on another device first.', ja: '他のデバイスがオフラインです。先に他のデバイスで同じアカウントにログインしてください。', ko: '다른 기기가 오프라인입니다. 다른 기기에서 같은 계정으로 로그인하세요.' },
  'chat.error.initializing': { 'zh-TW': '裝置還在初始化，請稍等幾秒再試。', 'zh-CN': '设备还在初始化，请稍等几秒再试。', en: 'Device is initializing. Wait a few seconds.', ja: 'デバイスを初期化中です。数秒お待ちください。', ko: '기기가 초기화 중입니다. 몇 초 후에 다시 시도하세요.' },
  'chat.error.tooLarge':     { 'zh-TW': '檔案超過 2GB 上限。超大檔請改用桌面 App（Pro）傳送。', 'zh-CN': '文件超过 2GB 上限。超大文件请改用桌面 App（Pro）传送。', en: 'File exceeds the 2GB limit. Use the desktop app (Pro) for larger files.', ja: 'ファイルが2GB上限を超えています。それ以上はデスクトップアプリ（Pro）をご利用ください。', ko: '파일이 2GB 한도를 초과합니다. 더 큰 파일은 데스크톱 앱(Pro)을 이용하세요.' },
  'chat.error.generic':      { 'zh-TW': '送出失敗',         'zh-CN': '发送失败',         en: 'Send failed',             ja: '送信失敗',         ko: '전송 실패' },
  'chat.error.storageFull':  { 'zh-TW': '本機儲存空間不足，無法暫存待傳檔案。請清空一些舊檔再試。', 'zh-CN': '本机存储空间不足，无法暂存待传文件。请清空一些旧文件再试。', en: 'Local storage full. Free up space before sending this file.', ja: 'ローカルストレージが不足しています。古いファイルを削除してください。', ko: '로컬 저장공간 부족. 오래된 파일을 삭제하세요.' },
  'chat.warn.storageLow':    { 'zh-TW': '⚠ 本機儲存空間即將用盡，請考慮清理。', 'zh-CN': '⚠ 本机存储即将用尽，请考虑清理。', en: '⚠ Local storage running low. Consider cleaning up.', ja: '⚠ ローカルストレージが少なくなっています。', ko: '⚠ 로컬 저장공간이 부족합니다.' },
  'chat.error.recvFull':     { 'zh-TW': '本機儲存空間不足，無法下載此檔案。請清空一些檔案再試。', 'zh-CN': '本机存储空间不足，无法下载此文件。', en: 'Local storage full. Cannot download this file.', ja: 'ローカルストレージ不足。ダウンロードできません。', ko: '로컬 저장공간 부족. 다운로드 불가.' },

  // 設定頁 storage / outbox 區塊
  'storage.title':           { 'zh-TW': '本機儲存',         'zh-CN': '本机存储',         en: 'Local storage',           ja: 'ローカルストレージ', ko: '로컬 저장공간' },
  'storage.used':            { 'zh-TW': '已使用',           'zh-CN': '已使用',           en: 'Used',                    ja: '使用済み',         ko: '사용됨' },
  'storage.outboxPending':   { 'zh-TW': '待傳檔案',         'zh-CN': '待传文件',         en: 'Pending uploads',         ja: '送信待ち',         ko: '전송 대기' },
  'storage.clearOutbox':     { 'zh-TW': '清空待傳佇列',     'zh-CN': '清空待传队列',     en: 'Clear pending queue',     ja: '送信待ちをクリア', ko: '대기열 지우기' },
  'storage.clearConfirm':    { 'zh-TW': '確定清空？所有等待傳送的訊息會被刪除。', 'zh-CN': '确定清空？所有等待传送的消息会被删除。', en: 'Clear all? All pending messages will be deleted.', ja: 'すべて削除しますか？', ko: '모두 삭제하시겠습니까?' },
  'storage.cleared':         { 'zh-TW': '已清空',           'zh-CN': '已清空',           en: 'Cleared',                 ja: 'クリアしました',   ko: '지워짐' },
  'storage.notSupported':    { 'zh-TW': '此瀏覽器不支援儲存空間查詢', 'zh-CN': '此浏览器不支持存储查询', en: 'Browser does not support storage estimate', ja: 'このブラウザは対応していません', ko: '브라우저가 지원하지 않음' },

  // ChatInput pending preview
  'chat.send':       { 'zh-TW': '送出',              'zh-CN': '发送',              en: 'Send',          ja: '送信',     ko: '전송' },
  'chat.sending':    { 'zh-TW': '送出中…',           'zh-CN': '发送中…',           en: 'Sending…',      ja: '送信中…',  ko: '전송 중…' },
  'chat.syncing':    { 'zh-TW': '同步中…',           'zh-CN': '同步中…',           en: 'Syncing…',      ja: '同期中…',  ko: '동기화 중…' },
  'chat.cancel':     { 'zh-TW': '取消',              'zh-CN': '取消',              en: 'Cancel',        ja: 'キャンセル', ko: '취소' },
  'chat.attachFile': { 'zh-TW': '附加檔案',          'zh-CN': '附加文件',          en: 'Attach file',   ja: 'ファイル添付', ko: '파일 첨부' },
  'chat.placeholder':{ 'zh-TW': '輸入訊息…',         'zh-CN': '输入消息…',         en: 'Type a message…', ja: 'メッセージ…', ko: '메시지 입력…' },
  'chat.captionPlaceholder': { 'zh-TW': '說明文字（選填）', 'zh-CN': '说明文字（选填）', en: 'Caption (optional)', ja: 'キャプション（任意）', ko: '설명 (선택)' },
  'chat.dropHint':   { 'zh-TW': '🎯 放開以上傳檔案', 'zh-CN': '🎯 放开以上传文件', en: '🎯 Drop to upload', ja: '🎯 ドロップでアップロード', ko: '🎯 놓아서 업로드' },

  // Timeline EmptyState
  'timeline.emptyTitle':  { 'zh-TW': '個人訊息檔案流',         'zh-CN': '个人消息档案流',         en: 'Your message & file stream',            ja: 'メッセージ・ファイルストリーム', ko: '메시지/파일 스트림' },
  'timeline.emptyHint':   { 'zh-TW': '輸入訊息或拖拉檔案上傳', 'zh-CN': '输入消息或拖拉文件上传', en: 'Type a message or drop files to upload', ja: 'メッセージ入力 / ファイルをドロップ', ko: '메시지 입력 또는 파일 드롭' },
  // Timeline 全區 drop overlay
  'timeline.dropZoneHint':    { 'zh-TW': '拖到這邊上傳檔案',     'zh-CN': '拖到这边上传文件',     en: 'Drop file here to upload',     ja: 'ここにドロップしてアップロード', ko: '여기에 놓아서 업로드' },
  'timeline.dropZoneSubhint': { 'zh-TW': '支援所有類型，最大 2 GB', 'zh-CN': '支援所有类型，最大 2 GB', en: 'Any type, up to 2 GB',         ja: '全形式対応、最大2GB',          ko: '모든 형식, 최대 2GB' },
  'timeline.welcomeTitle':{ 'zh-TW': '歡迎來到 AegisTrans',     'zh-CN': '欢迎来到 AegisTrans',     en: 'Welcome to AegisTrans',                  ja: 'AegisTrans へようこそ',     ko: 'AegisTrans에 오신 것을 환영합니다' },
  'timeline.welcomeIntro':{ 'zh-TW': '三件事先讓你知道：',     'zh-CN': '三件事先让你知道：',     en: 'Three things to know:',                  ja: '最初に3つのことを：',       ko: '먼저 알아야 할 세 가지:' },
  'timeline.welcomeCard1Title':{ 'zh-TW': '這是你「自己對自己」的同步工具', 'zh-CN': '这是你「自己对自己」的同步工具', en: 'A self-to-self sync tool', ja: '「自分から自分」への同期ツール', ko: '"나 자신에게" 동기화 도구' },
  'timeline.welcomeCard1Body': { 'zh-TW': '不能傳給朋友。所有訊息只在你登入過的裝置之間流動，類似 LINE Saved Messages 但跨平台、無雲端、不過期。', 'zh-CN': '不能传给朋友。所有消息只在你登录过的设备之间流动。', en: 'You cannot send to friends. Messages flow only between your own logged-in devices. Like LINE Saved Messages but cross-platform, cloudless, never expires.', ja: '友達に送れません。メッセージはあなたのデバイス間のみで流れます。', ko: '친구에게 보낼 수 없습니다. 메시지는 본인 기기 간에만 흐릅니다.' },
  'timeline.welcomeCard2Title':{ 'zh-TW': '端對端加密，連我們都看不到', 'zh-CN': '端对端加密，连我们都看不到', en: 'End-to-end encrypted; even we cannot see', ja: 'エンドツーエンド暗号化、私たちにも見えません', ko: '종단간 암호화 — 저희도 볼 수 없습니다' },
  'timeline.welcomeCard2Body': { 'zh-TW': '訊息與檔案在你裝置之間直接 P2P 加密傳輸，伺服器只做信令。即使我們的伺服器被駭，攻擊者只看到亂碼。', 'zh-CN': '消息与文件在你设备之间直接 P2P 加密传输，服务器只做信令。', en: 'Messages and files are P2P encrypted between your devices. Server only handles signaling.', ja: 'メッセージとファイルはデバイス間でP2P暗号化されます。サーバーはシグナリングのみ。', ko: '메시지와 파일은 기기 간 P2P 암호화됩니다. 서버는 시그널링만 처리합니다.' },
  'timeline.welcomeCard3Title':{ 'zh-TW': '在另一台裝置同帳號登入即自動配對', 'zh-CN': '在另一台设备同账号登录即自动配对', en: 'Sign in on another device — auto-pairs', ja: '他のデバイスで同じアカウントにログインすると自動ペアリング', ko: '다른 기기에서 같은 계정 로그인 시 자동 페어링' },
  'timeline.welcomeCard3Body': { 'zh-TW': '不用 QR、不用短碼。在新裝置打開 {web} 用同 email 登入，幾秒內就會出現在「我的裝置」。', 'zh-CN': '不用 QR、不用短码。', en: 'No QR, no codes. Open {web} on the new device with the same email — appears in "My devices" in seconds.', ja: 'QRも短いコードも不要。', ko: 'QR도 단축 코드도 필요 없음.' },
  'timeline.welcomeDismissBtn':{ 'zh-TW': '好的，開始使用', 'zh-CN': '好的，开始使用', en: 'Got it, let\'s go', ja: '了解、始めましょう', ko: '확인, 시작' },

  // DeviceListSidebar
  'devices.title':         { 'zh-TW': '我的裝置',     'zh-CN': '我的设备',     en: 'My Devices',     ja: 'マイデバイス',   ko: '내 기기' },
  'devices.online':        { 'zh-TW': '在線',         'zh-CN': '在线',         en: 'online',         ja: 'オンライン',     ko: '온라인' },
  'devices.empty':         { 'zh-TW': '尚無裝置',     'zh-CN': '暂无设备',     en: 'No devices',     ja: 'デバイスなし',   ko: '기기 없음' },
  'devices.thisDevice':    { 'zh-TW': '本機',         'zh-CN': '本机',         en: 'This device',    ja: 'このデバイス',   ko: '이 기기' },
  'devices.inUse':         { 'zh-TW': '正在使用',     'zh-CN': '正在使用',     en: 'In use',         ja: '使用中',         ko: '사용 중' },
  'devices.onlineLabel':   { 'zh-TW': '線上',         'zh-CN': '在线',         en: 'Online',         ja: 'オンライン',     ko: '온라인' },
  'devices.lastSeen':      { 'zh-TW': '最後',         'zh-CN': '最后',         en: 'Last seen',      ja: '最終',           ko: '마지막' },
  'devices.justNow':       { 'zh-TW': '剛剛',         'zh-CN': '刚刚',         en: 'just now',       ja: 'たった今',       ko: '방금' },
  'devices.minutesAgo':    { 'zh-TW': '分前',         'zh-CN': '分钟前',       en: 'min ago',        ja: '分前',           ko: '분 전' },
  'devices.hoursAgo':      { 'zh-TW': '小時前',       'zh-CN': '小时前',       en: 'h ago',          ja: '時間前',         ko: '시간 전' },
  'devices.daysAgo':       { 'zh-TW': '天前',         'zh-CN': '天前',         en: 'd ago',          ja: '日前',           ko: '일 전' },
  'devices.revoke':        { 'zh-TW': '撤銷',         'zh-CN': '撤销',         en: 'Revoke',         ja: '取り消し',       ko: '취소' },
  'devices.revokeTooltip': { 'zh-TW': '撤銷此裝置',   'zh-CN': '撤销此设备',   en: 'Revoke this device', ja: 'このデバイスを取り消し', ko: '이 기기 취소' },
  'devices.revokeSelfConfirm': { 'zh-TW': '撤銷此裝置 = 立即登出。確定？', 'zh-CN': '撤销此设备 = 立即登出。确定？', en: 'Revoking this device = immediate sign out. Continue?', ja: 'このデバイスの取り消し＝即時ログアウト。続行？', ko: '이 기기 취소 = 즉시 로그아웃. 계속?' },
  'devices.revokeOtherConfirm': { 'zh-TW': '撤銷此裝置？該裝置不再列在你的「我的裝置」群組中。', 'zh-CN': '撤销此设备？', en: 'Revoke this device? It will no longer appear in your "My devices" group.', ja: 'このデバイスを取り消しますか？', ko: '이 기기를 취소하시겠습니까?' },
  'devices.syncOnline':    { 'zh-TW': '同步通道已連線', 'zh-CN': '同步通道已连接', en: 'Sync channel online',     ja: '同期チャネル接続済み',   ko: '동기화 채널 온라인' },
  'devices.syncOffline':   { 'zh-TW': '同步通道未連線', 'zh-CN': '同步通道未连接', en: 'Sync channel offline',    ja: '同期チャネル未接続',     ko: '동기화 채널 오프라인' },

  // Phase 2 §6.4 螢幕分享 — 在裝置 row 上的投放按鈕
  'devices.shareScreen':         { 'zh-TW': '投放螢幕',     'zh-CN': '投放屏幕',     en: 'Cast screen',     ja: '画面を投影',     ko: '화면 캐스트' },
  'devices.shareScreenTooltip':  { 'zh-TW': '把我的螢幕投放到這台裝置', 'zh-CN': '把我的屏幕投放到这台设备', en: 'Cast my screen to this device', ja: 'この端末に自分の画面を投影', ko: '이 기기에 내 화면 캐스트' },
  'devices.shareScreenOffline':  { 'zh-TW': '裝置離線中，無法投放', 'zh-CN': '设备离线中，无法投放', en: 'Device offline; cannot cast', ja: 'デバイスがオフラインのため投影不可', ko: '기기 오프라인, 캐스트 불가' },

  // RemoteScreenViewer — 接受 / 拒絕對話框 + 全螢幕 viewer
  'screenShare.incomingTitle':   { 'zh-TW': '收到螢幕分享',   'zh-CN': '收到屏幕分享',   en: 'Incoming screen share', ja: '画面共有を受信',     ko: '화면 공유 수신' },
  'screenShare.fromDevice':      { 'zh-TW': '來自',           'zh-CN': '来自',           en: 'From',                  ja: '送信元',             ko: '발신' },
  'screenShare.acceptBtn':       { 'zh-TW': '接受',           'zh-CN': '接受',           en: 'Accept',                ja: '受け入れる',         ko: '수락' },
  'screenShare.rejectBtn':       { 'zh-TW': '拒絕',           'zh-CN': '拒绝',           en: 'Reject',                ja: '拒否',               ko: '거부' },
  'screenShare.viewing':         { 'zh-TW': '正在接收',       'zh-CN': '正在接收',       en: 'Viewing',               ja: '視聴中',             ko: '보는 중' },
  'screenShare.closeBtn':        { 'zh-TW': '關閉',           'zh-CN': '关闭',           en: 'Close',                 ja: '閉じる',             ko: '닫기' },
  'screenShare.fullscreenBtn':   { 'zh-TW': '瀏覽器全螢幕',   'zh-CN': '浏览器全屏',     en: 'Browser fullscreen',    ja: 'ブラウザ全画面',     ko: '브라우저 전체화면' },

  // Sender 端錯誤 / 提示
  'screenShare.notConnected':    { 'zh-TW': '裝置尚未建立 P2P 連線，請稍後再試', 'zh-CN': '设备尚未建立 P2P 连接，请稍后再试', en: 'P2P connection not ready, please try again', ja: 'P2P接続が未確立、後でやり直してください', ko: 'P2P 연결이 준비되지 않음, 잠시 후 다시 시도' },
  'screenShare.captureCancelled':{ 'zh-TW': '已取消擷取',     'zh-CN': '已取消捕获',     en: 'Capture cancelled',     ja: 'キャプチャをキャンセル', ko: '캡처 취소됨' },
  'screenShare.captureFailed':   { 'zh-TW': '無法擷取螢幕：', 'zh-CN': '无法捕获屏幕：', en: 'Cannot capture screen: ', ja: '画面キャプチャ失敗：', ko: '화면 캡처 실패: ' },
  'screenShare.peerRejected':    { 'zh-TW': '對方拒絕了螢幕分享', 'zh-CN': '对方拒绝了屏幕分享', en: 'The other device rejected the share', ja: '相手側が画面共有を拒否しました', ko: '상대방이 화면 공유를 거부했습니다' },
  'screenShare.proRequired':     { 'zh-TW': '螢幕分享為 Pro 功能',   'zh-CN': '屏幕分享为 Pro 功能',   en: 'Screen sharing is a Pro feature', ja: '画面共有はProの機能です', ko: '화면 공유는 Pro 기능입니다' },

  // ElectronTitleBar(桌面 Capacitor Electron 殼跨平台一致 chrome — Phase 2 §6.3)
  'titleBar.minimize':           { 'zh-TW': '最小化',         'zh-CN': '最小化',         en: 'Minimize',                ja: '最小化',                 ko: '최소화' },
  'titleBar.maximize':           { 'zh-TW': '最大化',         'zh-CN': '最大化',         en: 'Maximize',                ja: '最大化',                 ko: '최대화' },
  'titleBar.restore':            { 'zh-TW': '還原視窗',       'zh-CN': '还原窗口',       en: 'Restore window',          ja: 'ウィンドウを元に戻す',   ko: '창 복원' },
  'titleBar.close':              { 'zh-TW': '關閉視窗',       'zh-CN': '关闭窗口',       en: 'Close window',            ja: 'ウィンドウを閉じる',     ko: '창 닫기' },

  // DateSeparator
  'date.today':            { 'zh-TW': '今天',           'zh-CN': '今天',           en: 'Today',                   ja: '今日',                  ko: '오늘' },
  'date.yesterday':        { 'zh-TW': '昨天',           'zh-CN': '昨天',           en: 'Yesterday',               ja: '昨日',                  ko: '어제' },

  // MessageBubble actions
  'msg.copy':              { 'zh-TW': '複製文字',       'zh-CN': '复制文字',       en: 'Copy text',               ja: 'テキストをコピー',       ko: '텍스트 복사' },
  'msg.delete':            { 'zh-TW': '刪除',           'zh-CN': '删除',           en: 'Delete',                  ja: '削除',                  ko: '삭제' },
  'msg.deleteConfirm':     { 'zh-TW': '刪除此訊息？',   'zh-CN': '删除此消息？',   en: 'Delete this message?',    ja: 'このメッセージを削除？', ko: '이 메시지를 삭제하시겠습니까?' },
  'msg.download':          { 'zh-TW': '下載',           'zh-CN': '下载',           en: 'Download',                ja: 'ダウンロード',          ko: '다운로드' },
  'msg.retryDownload':     { 'zh-TW': '重試下載',       'zh-CN': '重试下载',       en: 'Retry download',          ja: '再ダウンロード',        ko: '다시 다운로드' },

  // 檔案傳輸進度（強調 P2P，不是雲端上傳）
  'file.sendingToPeers':   { 'zh-TW': '傳送至其他裝置中', 'zh-CN': '传送至其他设备中', en: 'Sending to your devices', ja: '他のデバイスへ送信中', ko: '다른 기기로 전송 중' },
  'file.receiving':        { 'zh-TW': '接收中',         'zh-CN': '接收中',         en: 'Receiving',               ja: '受信中',                 ko: '수신 중' },
  'file.waitingPeers':     { 'zh-TW': '等待其他裝置上線（檔案在本機，沒有上傳到雲端）', 'zh-CN': '等待其他设备上线（文件在本机，没有上传到云端）', en: 'Waiting for your other devices (file stays local — no cloud upload)', ja: '他のデバイスのオンラインを待機中（ファイルは端末内、クラウドアップロード無し）', ko: '다른 기기 대기 중 (파일은 로컬 — 클라우드 업로드 없음)' },
  'file.transferFailed':   { 'zh-TW': '傳送失敗',       'zh-CN': '传送失败',       en: 'Send failed',             ja: '送信失敗',               ko: '전송 실패' },
  'file.complete':         { 'zh-TW': '已送達',         'zh-CN': '已送达',         en: 'Delivered',               ja: '送信済み',               ko: '전송됨' },
  'file.open':             { 'zh-TW': '開啟',           'zh-CN': '打开',           en: 'Open',                    ja: '開く',                   ko: '열기' },
  'file.saveAs':           { 'zh-TW': '另存',           'zh-CN': '另存',           en: 'Save as',                 ja: '保存',                   ko: '저장' },
  'file.savedToDownloads': { 'zh-TW': '已儲存',         'zh-CN': '已保存',         en: 'saved',                   ja: '保存しました',           ko: '저장됨' },

  // ===== Phase 1A: Subscription / Paywall / Upgrade =====
  // Paywall modal
  'paywall.quotaTitle':    { 'zh-TW': '本機儲存空間已滿', 'zh-CN': '本机存储空间已满', en: 'Local storage full', ja: 'ローカル容量がいっぱいです', ko: '로컬 저장공간 가득 참' },
  'paywall.quotaBody':     { 'zh-TW': '已用 {used} / {quota}（免費版）。\n\n要傳送的檔案需 {needed}，無法塞進剩餘空間。\n\n升級 Pro 解除限制，或先清空一些舊檔。', 'zh-CN': '已用 {used} / {quota}（免费版）。\n\n要传送的文件需 {needed}，无法塞进剩余空间。\n\n升级 Pro 解除限制，或先清空一些旧文件。', en: 'Using {used} of {quota} (Free tier).\n\nThis file needs {needed} but won\'t fit.\n\nUpgrade to Pro for unlimited storage, or clear old files first.', ja: '{used} / {quota} 使用中（無料版）。\n\nこのファイルは {needed} 必要ですが、残り容量に収まりません。\n\nProにアップグレードするか、古いファイルを削除してください。', ko: '{used} / {quota} 사용 중 (무료).\n\n이 파일은 {needed} 필요하지만 공간이 부족합니다.\n\nPro로 업그레이드하거나 오래된 파일을 삭제하세요.' },
  'paywall.fileTitle':     { 'zh-TW': '單檔超過 2GB 需要 Pro', 'zh-CN': '单文件超过 2GB 需要 Pro', en: 'Files over 2GB need Pro', ja: '2GB超のファイルはPro限定', ko: '2GB 초과 파일은 Pro 필요' },
  'paywall.fileBody':      { 'zh-TW': '這個檔案 {size}，免費版單檔上限 {limit}。\n\n升級 Pro 即可用 App 收發不限大小的單一檔案（發送限桌面 App）。', 'zh-CN': '这个文件 {size}，免费版单文件上限 {limit}。\n\n升级 Pro 即可用 App 收发不限大小的单一文件（发送限桌面 App）。', en: 'This file is {size}; the free tier caps single files at {limit}.\n\nUpgrade to Pro to transfer files of any size in the app (sending requires the desktop app).', ja: 'このファイルは {size} で、無料版の1ファイル上限は {limit} です。\n\nProにアップグレードすると、アプリでサイズ無制限のファイルを受信できます（送信はデスクトップアプリのみ）。', ko: '이 파일은 {size}이며 무료 버전의 단일 파일 한도는 {limit}입니다.\n\nPro로 업그레이드하면 앱에서 크기 제한 없는 파일을 주고받을 수 있습니다(전송은 데스크톱 앱 전용).' },
  'paywall.deviceTitle':   { 'zh-TW': '裝置數已達上限', 'zh-CN': '设备数已达上限', en: 'Device limit reached', ja: 'デバイス数上限に到達', ko: '기기 수 한도 초과' },
  'paywall.deviceBody':    { 'zh-TW': '目前已連結 {count} 台裝置，免費版上限 {limit} 台。\n\n升級 Pro 可連結最多 10 台裝置，或移除不再使用的舊裝置。', 'zh-CN': '目前已连结 {count} 台设备，免费版上限 {limit} 台。\n\n升级 Pro 可连结最多 10 台设备，或移除不再使用的旧设备。', en: '{count} devices connected; free tier supports {limit}.\n\nUpgrade to Pro for up to 10 devices, or remove old devices.', ja: '{count} 台のデバイスが接続済み。無料版は {limit} 台までです。\n\nProなら最大10台、または古いデバイスを削除してください。', ko: '{count}대 기기 연결됨, 무료 한도는 {limit}대입니다.\n\nPro 업그레이드 시 최대 10대까지 가능합니다.' },
  'paywall.upgradeBtn':    { 'zh-TW': '升級 Pro 解除限制', 'zh-CN': '升级 Pro 解除限制', en: 'Upgrade to Pro', ja: 'Proにアップグレード', ko: 'Pro로 업그레이드' },
  'paywall.manageDevicesBtn': { 'zh-TW': '管理我的裝置',  'zh-CN': '管理我的设备',  en: 'Manage devices',  ja: 'デバイスを管理',  ko: '기기 관리' },
  'paywall.cancel':        { 'zh-TW': '稍後再說',       'zh-CN': '稍后再说',       en: 'Maybe later',             ja: '後で',             ko: '나중에' },
  'paywall.close':         { 'zh-TW': '關閉',           'zh-CN': '关闭',           en: 'Close',                   ja: '閉じる',           ko: '닫기' },

  // Upgrade page
  'upgrade.title':         { 'zh-TW': '升級 Pro',       'zh-CN': '升级 Pro',       en: 'Upgrade to Pro',          ja: 'Proにアップグレード', ko: 'Pro 업그레이드' },
  'upgrade.currentTier':   { 'zh-TW': '目前方案',       'zh-CN': '当前方案',       en: 'Current plan',            ja: '現在のプラン',     ko: '현재 플랜' },
  'upgrade.proBadge':      { 'zh-TW': 'Pro',            'zh-CN': 'Pro',            en: 'Pro',                     ja: 'Pro',              ko: 'Pro' },
  'upgrade.plansTitle':    { 'zh-TW': '選一個方案',     'zh-CN': '选一个方案',     en: 'Choose a plan',           ja: 'プランを選択',     ko: '플랜 선택' },
  'upgrade.tier.free':     { 'zh-TW': '免費版',         'zh-CN': '免费版',         en: 'Free',                    ja: '無料',             ko: '무료' },
  'upgrade.tier.monthly':  { 'zh-TW': '月訂',           'zh-CN': '月订',           en: 'Monthly',                 ja: '月額',             ko: '월간' },
  'upgrade.tier.yearly':   { 'zh-TW': '年訂',           'zh-CN': '年订',           en: 'Yearly',                  ja: '年額',             ko: '연간' },
  'upgrade.tier.lifetime': { 'zh-TW': '賣斷',           'zh-CN': '买断',           en: 'Lifetime',                ja: '買い切り',         ko: '평생' },
  'upgrade.desc.monthly':  { 'zh-TW': '每月扣款，隨時取消', 'zh-CN': '每月扣款，随时取消', en: 'Cancel anytime', ja: '毎月課金、いつでも解約可', ko: '매월 청구, 언제든 취소' },
  'upgrade.desc.yearly':   { 'zh-TW': '一次付清，比月訂省 17%', 'zh-CN': '一次付清，比月订省 17%', en: 'One payment, 17% off vs monthly', ja: '一括払い、月額より17%お得', ko: '한 번 결제, 월간 대비 17% 할인' },
  'upgrade.desc.lifetime': { 'zh-TW': '一次付清，永久 Pro，不再續費', 'zh-CN': '一次付清，永久 Pro，不再续费', en: 'One payment, Pro forever', ja: '一回払いで永久Pro', ko: '한 번 결제로 평생 Pro' },
  'upgrade.badgeYearly':   { 'zh-TW': '推薦',           'zh-CN': '推荐',           en: 'Best value',              ja: 'おすすめ',         ko: '추천' },
  'upgrade.badgeLifetime': { 'zh-TW': '最划算',         'zh-CN': '最划算',         en: 'Best value',              ja: '一番お得',         ko: '최고 가치' },
  'upgrade.mockBuyBtn':    { 'zh-TW': '購買（測試）',   'zh-CN': '购买（测试）',   en: 'Buy (test)',              ja: '購入（テスト）',  ko: '구매 (테스트)' },
  'upgrade.processing':    { 'zh-TW': '處理中…',        'zh-CN': '处理中…',        en: 'Processing…',             ja: '処理中…',          ko: '처리 중…' },
  'upgrade.mockHint':      { 'zh-TW': '⚠ Dev mode：點按鈕直接寫後端 dev license（不收費）。e2e 測試 + dogfood 用。', 'zh-CN': '⚠ Dev mode：点按钮直接写后端 dev license（不收费）。', en: '⚠ Dev mode: writes a dev license to backend (no charge). For e2e + dogfood only.', ja: '⚠ Devモード：開発用ライセンスを書き込むだけ（課金されません）。', ko: '⚠ Dev 모드: 개발용 라이센스만 기록 (실제 결제 없음).' },
  'upgrade.mockSuccess':   { 'zh-TW': '✓ 已升級到 {tier}（測試）', 'zh-CN': '✓ 已升级到 {tier}（测试）', en: '✓ Upgraded to {tier} (test)', ja: '✓ {tier}にアップグレード済み（テスト）', ko: '✓ {tier}로 업그레이드됨 (테스트)' },

  // IAP 真購買（iOS StoreKit）
  'upgrade.buyBtn':        { 'zh-TW': '購買', 'zh-CN': '购买', en: 'Subscribe', ja: '購入', ko: '구매' },
  'upgrade.buyLifetime':   { 'zh-TW': '買斷', 'zh-CN': '买断', en: 'Buy', ja: '購入', ko: '구매' },
  'upgrade.restoreBtn':    { 'zh-TW': '恢復購買', 'zh-CN': '恢复购买', en: 'Restore purchases', ja: '購入を復元', ko: '구매 복원' },
  'upgrade.restoring':     { 'zh-TW': '恢復中…', 'zh-CN': '恢复中…', en: 'Restoring…', ja: '復元中…', ko: '복원 중…' },
  'upgrade.purchaseSuccess': { 'zh-TW': '✓ 已升級到 {tier}', 'zh-CN': '✓ 已升级到 {tier}', en: '✓ Upgraded to {tier}', ja: '✓ {tier}にアップグレードしました', ko: '✓ {tier}로 업그레이드됨' },
  'upgrade.purchaseFailed': { 'zh-TW': '購買失敗', 'zh-CN': '购买失败', en: 'Purchase failed', ja: '購入に失敗しました', ko: '구매 실패' },
  'upgrade.purchasePending': { 'zh-TW': '購買待批准（如家長同意）', 'zh-CN': '购买待批准（如家长同意）', en: 'Purchase pending approval', ja: '購入の承認待ち', ko: '구매 승인 대기 중' },
  'upgrade.restoreNone':   { 'zh-TW': '沒有可恢復的購買', 'zh-CN': '没有可恢复的购买', en: 'No purchases to restore', ja: '復元できる購入がありません', ko: '복원할 구매가 없습니다' },
  'upgrade.iapTitle':      { 'zh-TW': '選擇方案', 'zh-CN': '选择方案', en: 'Choose a plan', ja: 'プランを選択', ko: '플랜 선택' },
  'upgrade.storeComingSoon': { 'zh-TW': '商店即將上架', 'zh-CN': '商店即将上架', en: 'Store listing coming soon', ja: 'ストア公開準備中', ko: '스토어 출시 예정' },
  'upgrade.autoRenewNotice': { 'zh-TW': '月訂與年訂會自動續訂，款項由商店帳號扣款。除非在目前週期結束前取消，否則會依所選週期續訂；取消後仍可使用至已付款週期結束。終身方案為一次性非消耗型購買。實際價格以付款畫面顯示為準。', 'zh-CN': '月订与年订会自动续订，款项由商店账号扣款。除非在当前周期结束前取消，否则会按所选周期续订；取消后仍可使用至已付款周期结束。终身方案为一次性非消耗型购买。实际价格以付款页面为准。', en: 'Monthly and yearly plans renew automatically and are charged to your store account unless cancelled before the current period ends. Access continues through the paid period after cancellation. Lifetime is a one-time non-consumable purchase. The checkout price controls.', ja: '月額・年額プランは、現在の期間終了前に解約しない限り自動更新され、ストアアカウントに請求されます。解約後も支払済み期間の終了まで利用できます。永久版は1回限りの非消耗型購入です。実際の価格は購入画面をご確認ください。', ko: '월간·연간 요금제는 현재 기간 종료 전에 취소하지 않으면 자동 갱신되며 스토어 계정으로 청구됩니다. 취소 후에도 결제 기간 종료까지 이용할 수 있습니다. 평생 요금제는 일회성 비소모성 구매입니다. 실제 가격은 결제 화면을 따릅니다.' },
  'upgrade.legalAgreement': { 'zh-TW': '購買即表示你同意服務條款與隱私政策。', 'zh-CN': '购买即表示你同意服务条款与隐私政策。', en: 'By purchasing, you agree to the Terms of Service and Privacy Policy.', ja: '購入により、利用規約とプライバシーポリシーに同意したものとみなされます。', ko: '구매하면 서비스 약관 및 개인정보 처리방침에 동의하는 것으로 간주됩니다.' },

  // App-only checkout（PWA 引導下載 native app 內購）
  'upgrade.appOnlyTitle':    { 'zh-TW': '透過 App 升級',         'zh-CN': '通过 App 升级',         en: 'Upgrade via App',                 ja: 'Appからアップグレード', ko: 'App에서 업그레이드' },
  'upgrade.appOnlyDesc':     { 'zh-TW': '升級後 PWA 與 App 自動同步解鎖', 'zh-CN': '升级后 PWA 与 App 自动同步解锁', en: 'PWA and app sync after upgrade', ja: 'アップグレード後PWAとAppで同期', ko: '업그레이드 후 PWA와 App 자동 동기화' },
  'upgrade.openAppStore':    { 'zh-TW': 'App Store',              'zh-CN': 'App Store',              en: 'App Store',                       ja: 'App Store',           ko: 'App Store' },
  'upgrade.openPlayStore':   { 'zh-TW': 'Google Play',            'zh-CN': 'Google Play',            en: 'Google Play',                     ja: 'Google Play',         ko: 'Google Play' },
  'upgrade.scanQrPrompt':    { 'zh-TW': '掃描 QR 下載',           'zh-CN': '扫描 QR 下载',           en: 'Scan QR to download',             ja: 'QRをスキャン',        ko: 'QR 스캔하여 다운로드' },
  'upgrade.appOnlyFootnote': { 'zh-TW': 'App 即將上架',           'zh-CN': 'App 即将上架',           en: 'App coming soon',                 ja: 'App近日公開',         ko: 'App 곧 출시' },
  'upgrade.storeLoadError':  { 'zh-TW': '無法載入商店商品，請檢查網路後重試。', 'zh-CN': '无法加载商店商品，请检查网络后重试。', en: 'Could not load store products. Check your connection and retry.', ja: 'ストア商品を読み込めませんでした。接続を確認して再試行してください。', ko: '스토어 상품을 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.' },
  'upgrade.storeRetry':      { 'zh-TW': '重試', 'zh-CN': '重试', en: 'Retry', ja: '再試行', ko: '다시 시도' },

  // 跨商店升級（Schema B）：訂閱中買終身的確認 + 舊訂閱取消提醒
  'upgrade.confirmUpgradeBody': { 'zh-TW': '你目前已有訂閱中的方案。終身方案是更高階的永久版，購買後：Google Play 訂閱會自動為你取消；Apple 訂閱需由你手動取消（我們會持續提醒）。確定升級？', 'zh-CN': '你当前已有订阅中的方案。终身方案是更高阶的永久版，购买后：Google Play 订阅会自动为你取消；Apple 订阅需由你手动取消（我们会持续提醒）。确定升级？', en: 'You already have an active subscription. Lifetime is a higher, permanent plan. After purchase, Google Play subscriptions are cancelled for you automatically; Apple subscriptions must be cancelled by you (we will keep reminding you). Upgrade now?', ja: '現在サブスクリプション中のプランがあります。永久版はより上位の買い切りプランです。購入後、Google Playのサブスクリプションは自動的に解約されます。Appleのサブスクリプションはご自身での解約が必要です（リマインドを表示し続けます）。アップグレードしますか？', ko: '이미 구독 중인 요금제가 있습니다. 평생 요금제는 더 높은 영구 요금제입니다. 구매 후 Google Play 구독은 자동으로 취소되며, Apple 구독은 직접 취소해야 합니다(계속 알려드립니다). 업그레이드할까요?' },
  'upgrade.confirmUpgradeYes': { 'zh-TW': '確認升級', 'zh-CN': '确认升级', en: 'Confirm upgrade', ja: 'アップグレード確定', ko: '업그레이드 확인' },
  'upgrade.confirmUpgradeNo':  { 'zh-TW': '取消', 'zh-CN': '取消', en: 'Cancel', ja: 'キャンセル', ko: '취소' },
  'upgrade.redundantApple':  { 'zh-TW': '你的 Apple 訂閱（{tier}）仍在自動扣款。你已擁有更高階方案，請前往「管理 Apple 訂閱」取消；取消後此提醒會自動消失。', 'zh-CN': '你的 Apple 订阅（{tier}）仍在自动扣款。你已拥有更高阶方案，请前往「管理 Apple 订阅」取消；取消后此提醒会自动消失。', en: 'Your Apple subscription ({tier}) is still auto-renewing. You already own a higher plan — cancel it via "Manage Apple subscription". This reminder disappears once cancelled.', ja: 'Appleのサブスクリプション（{tier}）はまだ自動更新中です。すでに上位プランをお持ちです。「Appleサブスクリプションを管理」から解約してください。解約後、この通知は消えます。', ko: 'Apple 구독({tier})이 아직 자동 갱신 중입니다. 이미 더 높은 요금제를 보유 중이니 "Apple 구독 관리"에서 취소해 주세요. 취소하면 이 알림은 사라집니다.' },
  'upgrade.redundantGoogle': { 'zh-TW': '你的 Google Play 訂閱（{tier}）仍在自動扣款。系統會自動為你取消；若此提醒持續顯示，請前往「管理 Google Play 訂閱」手動取消。', 'zh-CN': '你的 Google Play 订阅（{tier}）仍在自动扣款。系统会自动为你取消；若此提醒持续显示，请前往「管理 Google Play 订阅」手动取消。', en: 'Your Google Play subscription ({tier}) is still auto-renewing. We cancel it for you automatically; if this reminder persists, cancel it via "Manage Google Play subscription".', ja: 'Google Playのサブスクリプション（{tier}）はまだ自動更新中です。通常は自動的に解約されます。この通知が消えない場合は「Google Playサブスクリプションを管理」から解約してください。', ko: 'Google Play 구독({tier})이 아직 자동 갱신 중입니다. 자동으로 취소되지만, 이 알림이 계속 표시되면 "Google Play 구독 관리"에서 직접 취소해 주세요.' },

  // Subscription section in Settings
  'subscription.title':       { 'zh-TW': '訂閱方案',       'zh-CN': '订阅方案',       en: 'Subscription',           ja: 'サブスクリプション', ko: '구독' },
  'subscription.currentPlan': { 'zh-TW': '目前方案',       'zh-CN': '当前方案',       en: 'Current plan',           ja: '現在のプラン',     ko: '현재 플랜' },
  'subscription.usageLabel':  { 'zh-TW': '已用空間',       'zh-CN': '已用空间',       en: 'Used',                   ja: '使用済み',         ko: '사용량' },
  'subscription.upgrade':     { 'zh-TW': '升級 Pro',       'zh-CN': '升级 Pro',       en: 'Upgrade to Pro',         ja: 'Proにアップグレード', ko: 'Pro 업그레이드' },
  'subscription.upgradeNow':  { 'zh-TW': '⚠ 已達上限，立即升級', 'zh-CN': '⚠ 已达上限，立即升级', en: '⚠ At limit — upgrade now', ja: '⚠ 上限到達 — 今すぐアップグレード', ko: '⚠ 한도 도달 — 지금 업그레이드' },
  'subscription.manageApple': { 'zh-TW': '管理 Apple 訂閱', 'zh-CN': '管理 Apple 订阅', en: 'Manage Apple subscription', ja: 'Appleサブスクリプションを管理', ko: 'Apple 구독 관리' },
  'subscription.manageGoogle':{ 'zh-TW': '管理 Google Play 訂閱', 'zh-CN': '管理 Google Play 订阅', en: 'Manage Google Play subscription', ja: 'Google Playサブスクリプションを管理', ko: 'Google Play 구독 관리' },
  // quota source 說明（讓使用者知道為什麼是 2GB 而不是裝置實際空間）
  'subscription.quotaSourceFree':   { 'zh-TW': '免費版上限',     'zh-CN': '免费版上限',     en: 'Free tier limit',         ja: '無料版の上限',     ko: '무료 한도' },
  'subscription.quotaSourceDevice': { 'zh-TW': '受裝置可用空間', 'zh-CN': '受设备可用空间', en: 'Device available space',  ja: 'デバイスの空き容量', ko: '기기 가용 공간' },

  // ===== Auth / 登入畫面（EmailAuthScreen）=====
  'auth.subtitle.locked':   { 'zh-TW': '工作階段已鎖定 — 輸入密碼解鎖', 'zh-CN': '会话已锁定 — 输入密码解锁', en: 'Session locked — enter password to unlock', ja: 'セッションがロックされています — パスワードを入力して解除', ko: '세션이 잠겼습니다 — 비밀번호를 입력해 잠금 해제' },
  'auth.subtitle.login':    { 'zh-TW': '跨裝置自己對自己的訊息與檔案同步工具', 'zh-CN': '跨设备自己对自己的消息与文件同步工具', en: 'Sync your own messages and files across your devices', ja: '自分のデバイス間でメッセージとファイルを同期', ko: '내 기기 간 메시지와 파일 동기화 도구' },
  'auth.subtitle.register': { 'zh-TW': '建立新帳號', 'zh-CN': '创建新账号', en: 'Create a new account', ja: '新しいアカウントを作成', ko: '새 계정 만들기' },
  'auth.subtitle.forgot':   { 'zh-TW': '重設你的密碼', 'zh-CN': '重设你的密码', en: 'Reset your password', ja: 'パスワードをリセット', ko: '비밀번호 재설정' },
  'auth.lockedNotice':      { 'zh-TW': '為了保護資料，重啟 app 後身分會上鎖。重新輸入密碼即可解鎖 —— 你的訊息與裝置都還在。', 'zh-CN': '为了保护数据，重启 app 后身份会上锁。重新输入密码即可解锁 —— 你的消息与设备都还在。', en: 'To protect your data, your identity locks after an app restart. Re-enter your password to unlock — your messages and devices are still here.', ja: 'データ保護のため、アプリ再起動後は本人確認がロックされます。パスワードを再入力すると解除されます — メッセージとデバイスはそのままです。', ko: '데이터 보호를 위해 앱 재시작 후 신원이 잠깁니다. 비밀번호를 다시 입력하면 잠금이 해제됩니다 — 메시지와 기기는 그대로 있습니다.' },
  'auth.passwordLabel':     { 'zh-TW': '密碼', 'zh-CN': '密码', en: 'Password', ja: 'パスワード', ko: '비밀번호' },
  'auth.passwordPlaceholder': { 'zh-TW': '至少 8 字元', 'zh-CN': '至少 8 字符', en: 'At least 8 characters', ja: '8文字以上', ko: '8자 이상' },
  'auth.btn.login':         { 'zh-TW': '登入', 'zh-CN': '登录', en: 'Sign in', ja: 'ログイン', ko: '로그인' },
  'auth.btn.loginBusy':     { 'zh-TW': '登入中…', 'zh-CN': '登录中…', en: 'Signing in…', ja: 'ログイン中…', ko: '로그인 중…' },
  'auth.btn.register':      { 'zh-TW': '寄送註冊連結', 'zh-CN': '发送注册链接', en: 'Send sign-up link', ja: '登録リンクを送信', ko: '가입 링크 보내기' },
  'auth.btn.forgot':        { 'zh-TW': '寄送重設連結', 'zh-CN': '发送重设链接', en: 'Send reset link', ja: 'リセットリンクを送信', ko: '재설정 링크 보내기' },
  'auth.btn.sending':       { 'zh-TW': '寄送中…', 'zh-CN': '发送中…', en: 'Sending…', ja: '送信中…', ko: '보내는 중…' },
  'auth.noAccount':         { 'zh-TW': '還沒有帳號?', 'zh-CN': '还没有账号?', en: "Don't have an account?", ja: 'アカウントをお持ちでない方', ko: '계정이 없으신가요?' },
  'auth.register':          { 'zh-TW': '註冊', 'zh-CN': '注册', en: 'Sign up', ja: '登録', ko: '가입' },
  'auth.forgotPassword':    { 'zh-TW': '忘記密碼?', 'zh-CN': '忘记密码?', en: 'Forgot password?', ja: 'パスワードをお忘れですか?', ko: '비밀번호를 잊으셨나요?' },
  'auth.registerHint':      { 'zh-TW': '點郵件連結驗證後會建立帳號，下一步設定密碼。', 'zh-CN': '点邮件链接验证后会创建账号，下一步设置密码。', en: 'Verify via the email link to create your account, then set a password.', ja: 'メールのリンクで認証するとアカウントが作成され、次にパスワードを設定します。', ko: '이메일 링크로 인증하면 계정이 생성되고, 다음 단계에서 비밀번호를 설정합니다.' },
  'auth.hasAccount':        { 'zh-TW': '已有帳號?', 'zh-CN': '已有账号?', en: 'Already have an account?', ja: 'すでにアカウントをお持ちの方', ko: '이미 계정이 있으신가요?' },
  'auth.forgotHint':        { 'zh-TW': '點郵件連結驗證後即可設定新密碼。', 'zh-CN': '点邮件链接验证后即可设置新密码。', en: 'Verify via the email link to set a new password.', ja: 'メールのリンクで認証すると新しいパスワードを設定できます。', ko: '이메일 링크로 인증하면 새 비밀번호를 설정할 수 있습니다.' },
  'auth.rememberedQ':       { 'zh-TW': '想起來了?', 'zh-CN': '想起来了?', en: 'Remembered it?', ja: '思い出しましたか?', ko: '기억나셨나요?' },
  'auth.backToLogin':       { 'zh-TW': '回登入', 'zh-CN': '回登录', en: 'Back to sign in', ja: 'ログインに戻る', ko: '로그인으로 돌아가기' },
  'auth.wait.titleReset':   { 'zh-TW': '請查收重設連結', 'zh-CN': '请查收重设链接', en: 'Check your email for the reset link', ja: 'リセットリンクをご確認ください', ko: '재설정 링크를 확인하세요' },
  'auth.wait.titleVerify':  { 'zh-TW': '請查收驗證連結', 'zh-CN': '请查收验证链接', en: 'Check your email for the verification link', ja: '認証リンクをご確認ください', ko: '인증 링크를 확인하세요' },
  'auth.wait.sentTo':       { 'zh-TW': '我們已寄送連結到', 'zh-CN': '我们已发送链接到', en: "We've sent a link to", ja: 'リンクを送信しました：', ko: '링크를 보냈습니다:' },
  'auth.wait.afterClick':   { 'zh-TW': '點擊郵件中的連結後，', 'zh-CN': '点击邮件中的链接后，', en: 'After you click the link in the email,', ja: 'メール内のリンクをクリックすると、', ko: '이메일의 링크를 클릭하면,' },
  'auth.wait.autoContinue': { 'zh-TW': '此頁面會自動繼續', 'zh-CN': '此页面会自动继续', en: 'this page continues automatically', ja: 'このページは自動的に進みます', ko: '이 페이지가 자동으로 계속됩니다' },
  'auth.wait.mayTakeTime':  { 'zh-TW': '收信可能需要 1-2 分鐘。也檢查垃圾信件夾。', 'zh-CN': '收信可能需要 1-2 分钟。也检查垃圾邮件夹。', en: 'It may take 1-2 minutes to arrive. Check your spam folder too.', ja: '届くまで1〜2分かかる場合があります。迷惑メールフォルダもご確認ください。', ko: '도착하는 데 1-2분 걸릴 수 있습니다. 스팸 폴더도 확인하세요.' },
  'auth.wait.waiting':      { 'zh-TW': '等候中…', 'zh-CN': '等候中…', en: 'Waiting…', ja: '待機中…', ko: '대기 중…' },
  'auth.wait.resending':    { 'zh-TW': '重新寄送中…', 'zh-CN': '重新发送中…', en: 'Resending…', ja: '再送信中…', ko: '다시 보내는 중…' },
  'auth.wait.notReceived':  { 'zh-TW': '沒收到?重新寄送', 'zh-CN': '没收到?重新发送', en: "Didn't get it? Resend", ja: '届きませんか?再送信', ko: '못 받으셨나요? 다시 보내기' },
  'auth.wait.cancel':       { 'zh-TW': '取消，改用其他 email', 'zh-CN': '取消，改用其他 email', en: 'Cancel, use a different email', ja: 'キャンセルして別のメールを使う', ko: '취소하고 다른 이메일 사용' },

  // ===== 裝置上限 gate（DeviceLimitGate）=====
  'deviceGate.title':       { 'zh-TW': '裝置數已達上限', 'zh-CN': '设备数已达上限', en: 'Device limit reached', ja: 'デバイス数が上限に達しました', ko: '기기 수가 한도에 도달했습니다' },
  'deviceGate.body':        { 'zh-TW': '帳號已連結 {count} 台裝置（上限 {limit} 台）。要在這台裝置登入，請先撤銷一台不再使用的裝置，或升級 Pro 解除限制。', 'zh-CN': '账号已连接 {count} 台设备（上限 {limit} 台）。要在这台设备登录，请先撤销一台不再使用的设备，或升级 Pro 解除限制。', en: 'Your account has {count} devices linked (limit {limit}). To sign in on this device, revoke one you no longer use, or upgrade to Pro to lift the limit.', ja: 'アカウントに{count}台のデバイスがリンクされています（上限{limit}台）。このデバイスでログインするには、使わないデバイスを1台取り消すか、Proにアップグレードしてください。', ko: '계정에 {count}대의 기기가 연결되어 있습니다(한도 {limit}대). 이 기기에서 로그인하려면 더 이상 사용하지 않는 기기를 취소하거나 Pro로 업그레이드하세요.' },
  'deviceGate.revoke':      { 'zh-TW': '撤銷', 'zh-CN': '撤销', en: 'Revoke', ja: '取り消し', ko: '취소' },
  'deviceGate.revoking':    { 'zh-TW': '撤銷中…', 'zh-CN': '撤销中…', en: 'Revoking…', ja: '取り消し中…', ko: '취소 중…' },
  'deviceGate.thisDevice':  { 'zh-TW': '本機', 'zh-CN': '本机', en: 'This device', ja: 'このデバイス', ko: '이 기기' },
  'deviceGate.upgrade':     { 'zh-TW': '升級 Pro 解除限制', 'zh-CN': '升级 Pro 解除限制', en: 'Upgrade to Pro to lift the limit', ja: 'Proにアップグレードして上限を解除', ko: 'Pro로 업그레이드하여 한도 해제' },
  'deviceGate.cancel':      { 'zh-TW': '取消登入', 'zh-CN': '取消登录', en: 'Cancel sign-in', ja: 'ログインをキャンセル', ko: '로그인 취소' },
  'deviceGate.lastSeen':    { 'zh-TW': '最後活躍', 'zh-CN': '最后活跃', en: 'Last active', ja: '最終アクティブ', ko: '마지막 활동' },
  'deviceGate.revokeFailed':{ 'zh-TW': '撤銷失敗，請稍後再試。', 'zh-CN': '撤销失败，请稍后再试。', en: 'Failed to revoke, please try again.', ja: '取り消しに失敗しました。後でやり直してください。', ko: '취소에 실패했습니다. 잠시 후 다시 시도하세요.' },
  'deviceGate.loginFailed': { 'zh-TW': '登入失敗，請稍後再試。', 'zh-CN': '登录失败，请稍后再试。', en: 'Sign-in failed, please try again.', ja: 'ログインに失敗しました。後でやり直してください。', ko: '로그인에 실패했습니다. 잠시 후 다시 시도하세요.' },
  'deviceGate.signedOut':   { 'zh-TW': '這台裝置的登入已失效（撤銷了本機，或登入已過期）。請重新登入。', 'zh-CN': '这台设备的登录已失效（撤销了本机，或登录已过期）。请重新登录。', en: 'This device is no longer signed in (it was revoked, or the sign-in expired). Please sign in again.', ja: 'このデバイスのログインは無効になりました（このデバイスを取り消したか、ログインの期限が切れました）。もう一度ログインしてください。', ko: '이 기기의 로그인이 더 이상 유효하지 않습니다(이 기기를 취소했거나 로그인이 만료됨). 다시 로그인하세요.' },
  'deviceGate.signInAgain': { 'zh-TW': '重新登入', 'zh-CN': '重新登录', en: 'Sign in again', ja: 'もう一度ログイン', ko: '다시 로그인' },
  'deviceGate.networkError':{ 'zh-TW': '網路錯誤', 'zh-CN': '网络错误', en: 'Network error', ja: 'ネットワークエラー', ko: '네트워크 오류' },

  // ===== 設定/重設密碼 overlay（App.tsx PasswordOnboardOverlay / ResetPasswordOverlay）=====
  'pwOverlay.onboardTitle': { 'zh-TW': '設定登入密碼', 'zh-CN': '设置登录密码', en: 'Set a sign-in password', ja: 'ログインパスワードを設定', ko: '로그인 비밀번호 설정' },
  'pwOverlay.onboardHint':  { 'zh-TW': '幫你的帳號設一組密碼，之後就用 email + 密碼登入。', 'zh-CN': '帮你的账号设一组密码，之后就用 email + 密码登录。', en: 'Set a password for your account; afterward sign in with email + password.', ja: 'アカウントにパスワードを設定します。今後はメール＋パスワードでログインします。', ko: '계정에 비밀번호를 설정하세요. 이후에는 이메일 + 비밀번호로 로그인합니다.' },
  'pwOverlay.resetTitle':   { 'zh-TW': '設定新密碼', 'zh-CN': '设置新密码', en: 'Set a new password', ja: '新しいパスワードを設定', ko: '새 비밀번호 설정' },
  'pwOverlay.resetHint':    { 'zh-TW': '驗證成功，請設定新的登入密碼。', 'zh-CN': '验证成功，请设置新的登录密码。', en: 'Verified — set your new sign-in password.', ja: '認証に成功しました。新しいログインパスワードを設定してください。', ko: '인증되었습니다. 새 로그인 비밀번호를 설정하세요.' },
  'pwOverlay.newPlaceholder': { 'zh-TW': '新密碼（至少 8 字元）', 'zh-CN': '新密码（至少 8 字符）', en: 'New password (≥ 8 chars)', ja: '新しいパスワード（8文字以上）', ko: '새 비밀번호 (8자 이상)' },
  'pwOverlay.confirmPlaceholder': { 'zh-TW': '再輸入一次', 'zh-CN': '再输入一次', en: 'Re-enter', ja: 'もう一度', ko: '다시 입력' },
  'pwOverlay.tooShort':     { 'zh-TW': '密碼至少 8 字元', 'zh-CN': '密码至少 8 字符', en: 'Password must be at least 8 characters', ja: 'パスワードは8文字以上必要です', ko: '비밀번호는 8자 이상이어야 합니다' },
  'pwOverlay.mismatch':     { 'zh-TW': '兩次輸入不一致', 'zh-CN': '两次输入不一致', en: 'Passwords do not match', ja: 'パスワードが一致しません', ko: '비밀번호가 일치하지 않습니다' },
  'pwOverlay.submit':       { 'zh-TW': '設定密碼', 'zh-CN': '设置密码', en: 'Set password', ja: 'パスワードを設定', ko: '비밀번호 설정' },
  'pwOverlay.submitting':   { 'zh-TW': '設定中…', 'zh-CN': '设置中…', en: 'Setting…', ja: '設定中…', ko: '설정 중…' },
  'pwOverlay.failed':       { 'zh-TW': '設定失敗，請再試一次', 'zh-CN': '设置失败，请再试一次', en: 'Failed to set password, please try again', ja: '設定に失敗しました。もう一度お試しください', ko: '비밀번호 설정에 실패했습니다. 다시 시도하세요' },

  // ===== 伺服器選擇（components/Settings/ServerSettings.tsx）=====
  'timeline.webFallback':   { 'zh-TW': 'AegisTrans App', 'zh-CN': 'AegisTrans App', en: 'the AegisTrans app', ja: 'AegisTrans アプリ', ko: 'AegisTrans 앱' },
  'server.title':           { 'zh-TW': '伺服器', 'zh-CN': '服务器', en: 'Server', ja: 'サーバー', ko: '서버' },
  'server.official':        { 'zh-TW': '官方伺服器', 'zh-CN': '官方服务器', en: 'Official server', ja: '公式サーバー', ko: '공식 서버' },
  'server.custom':          { 'zh-TW': '自訂伺服器', 'zh-CN': '自定义服务器', en: 'Custom server', ja: 'カスタムサーバー', ko: '사용자 지정 서버' },
  'server.current':         { 'zh-TW': '目前連線', 'zh-CN': '当前连接', en: 'Connected to', ja: '接続先', ko: '연결 대상' },
  'server.change':          { 'zh-TW': '變更', 'zh-CN': '更改', en: 'Change', ja: '変更', ko: '변경' },
  'server.urlLabel':        { 'zh-TW': '伺服器 API 網址', 'zh-CN': '服务器 API 地址', en: 'Server API URL', ja: 'サーバー API の URL', ko: '서버 API URL' },
  'server.urlHint':         { 'zh-TW': '填自架伺服器的 API 網址（https://…）。MQTT 等連線設定會自動向伺服器取得。', 'zh-CN': '填自建服务器的 API 地址（https://…）。MQTT 等连接设置会自动向服务器获取。', en: 'Enter your server\'s API URL (https://…). MQTT and other settings are fetched from the server.', ja: '自前サーバーの API URL（https://…）を入力してください。MQTT などの設定はサーバーから自動取得します。', ko: '자체 서버의 API URL(https://…)을 입력하세요. MQTT 등 설정은 서버에서 자동으로 가져옵니다.' },
  'server.check':           { 'zh-TW': '檢查', 'zh-CN': '检查', en: 'Check', ja: '確認', ko: '확인' },
  'server.checking':        { 'zh-TW': '檢查中…', 'zh-CN': '检查中…', en: 'Checking…', ja: '確認中…', ko: '확인 중…' },
  'server.found':           { 'zh-TW': '找到伺服器', 'zh-CN': '找到服务器', en: 'Server found', ja: 'サーバーが見つかりました', ko: '서버를 찾았습니다' },
  'server.switch':          { 'zh-TW': '切換到這台伺服器', 'zh-CN': '切换到这台服务器', en: 'Switch to this server', ja: 'このサーバーに切り替え', ko: '이 서버로 전환' },
  'server.useOfficial':     { 'zh-TW': '改回官方伺服器', 'zh-CN': '改回官方服务器', en: 'Use the official server', ja: '公式サーバーに戻す', ko: '공식 서버로 돌아가기' },
  'server.cancel':          { 'zh-TW': '取消', 'zh-CN': '取消', en: 'Cancel', ja: 'キャンセル', ko: '취소' },
  'server.switching':       { 'zh-TW': '切換中…', 'zh-CN': '切换中…', en: 'Switching…', ja: '切り替え中…', ko: '전환 중…' },
  'server.confirmSignOut':  { 'zh-TW': '切換伺服器會登出並重新開啟 App。之後若在新伺服器登入，這台裝置上目前帳號的訊息與檔案會被清除。要繼續嗎？', 'zh-CN': '切换服务器会退出登录并重新打开 App。之后若在新服务器登录，这台设备上当前账号的消息与文件会被清除。要继续吗？', en: 'Switching servers signs you out and restarts the app. If you then sign in on the new server, this device\'s messages and files for the current account are deleted. Continue?', ja: 'サーバーを切り替えるとログアウトし、アプリを再起動します。新しいサーバーでログインすると、この端末の現在のアカウントのメッセージとファイルは削除されます。続けますか？', ko: '서버를 전환하면 로그아웃되고 앱이 다시 시작됩니다. 새 서버에서 로그인하면 이 기기의 현재 계정 메시지와 파일이 삭제됩니다. 계속할까요?' },
  'server.err.invalid_url': { 'zh-TW': '網址格式不對', 'zh-CN': '地址格式不对', en: 'That URL is not valid', ja: 'URL の形式が正しくありません', ko: 'URL 형식이 올바르지 않습니다' },
  'server.err.insecure_url':{ 'zh-TW': '只能用 https（本機開發的 localhost 除外）', 'zh-CN': '只能用 https（本机开发的 localhost 除外）', en: 'Only https is allowed (except localhost for development)', ja: 'https のみ使用できます（開発用の localhost を除く）', ko: 'https만 사용할 수 있습니다(개발용 localhost 제외)' },
  'server.err.unreachable': { 'zh-TW': '連不到這台伺服器', 'zh-CN': '连不到这台服务器', en: 'Could not reach that server', ja: 'サーバーに接続できません', ko: '서버에 연결할 수 없습니다' },
  'server.err.not_aegistrans': { 'zh-TW': '這個網址不是 AegisTrans 伺服器', 'zh-CN': '这个地址不是 AegisTrans 服务器', en: 'That URL is not an AegisTrans server', ja: 'この URL は AegisTrans サーバーではありません', ko: '이 URL은 AegisTrans 서버가 아닙니다' },
  'server.err.bad_config':  { 'zh-TW': '伺服器的連線設定不完整（需要 wss:// 的 MQTT 網址）', 'zh-CN': '服务器的连接设置不完整（需要 wss:// 的 MQTT 地址）', en: 'The server\'s configuration is incomplete (it must provide a wss:// MQTT URL)', ja: 'サーバーの設定が不完全です（wss:// の MQTT URL が必要）', ko: '서버 설정이 불완전합니다(wss:// MQTT URL 필요)' },
  'server.err.save_failed': { 'zh-TW': '無法儲存設定（瀏覽器可能在私密模式）', 'zh-CN': '无法保存设置（浏览器可能在隐私模式）', en: 'Could not save the setting (private browsing?)', ja: '設定を保存できません（プライベートモードの可能性）', ko: '설정을 저장할 수 없습니다(비공개 모드일 수 있음)' },
} as const satisfies Record<string, LangMap>;

export type AegisStringKey = keyof typeof STRINGS;

export function aegisT(language: Language, key: AegisStringKey): string {
  return STRINGS[key][language] ?? STRINGS[key]['en'] ?? key;
}
