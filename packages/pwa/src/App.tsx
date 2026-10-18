import './index.css';
import { useEffect, useState, useRef, type FormEvent } from 'react';
import { useAuth } from './hooks/useAuth';
import { useDevicePresence } from './hooks/useDevicePresence';
import { useIsDesktop } from './hooks/useIsDesktop';
import { EmailAuthScreen, PW_RESET_FLAG } from './pages/EmailAuthScreen';
import { SyncingIndicator } from './components/common/SyncingIndicator';
import { VerifyPage } from './pages/VerifyPage';
import { Timeline } from './pages/Timeline';
import { DeviceListSidebar } from './components/DeviceListSidebar';
import { BottomNav, type Tab } from './components/BottomNav';
import { useLanguage } from './i18n/context';
import { aegisT } from './i18n/aegistrans-strings';
import { PasswordInput } from './components/PasswordInput';
import { SettingsPage } from './pages/SettingsPage';
import { clearIdentity } from './services/identity';
import { getEncryptionKey, restoreEncryptionKeyFromSession } from './services/keyEncryption';
import { registerCurrentDevice, listDevices, onDeviceListFetched, resetPassword, type Device, type RegisterDeviceResult } from './services/auth';
import { mqttService, ConnectionState, MessageType, type MqttMessage } from './services/mqtt';
import { mqttHealthMonitor } from './services/mqttHealthMonitor';
import { peerHealthMonitor } from './services/peerHealthMonitor';
import { initPeerSync, shutdownPeerSync, connectToPeers, disconnectPeer, retryPendingForKey, pruneToAccountPeers, observeAccountDeviceList } from './services/peerSync';
import { accountDeviceCheck, accountDevicePersistence, setAccountDeviceCheck, isConfirmedAccountDevice, invalidateAccountDevices, observeFetchedDeviceList } from './services/accountDevices';
import { clearOutboxForPeer } from './services/p2pSend';
import {
  initDevicePairing,
  shutdownDevicePairing,
  registerCryptoFunctions,
  unregisterCryptoFunctions,
  requestPairingWithMany,
  requestRepairWith,
} from './services/devicePairing';
import {
  dispatchGroupKeyTo,
  rotateGroupKeyAndDispatch,
  requestGroupKeyFrom,
  dispatchGroupKeyByIdTo,
  myDevicesGroupId,
} from './services/myDevicesGroup';
import * as groupKeyService from './services/groupKey';
import { RatchetMessage, Identity } from './services/crypto';
import { preKeyRotationService } from './services/preKeyRotation';
import { diagLog } from './utils/diagLog';
import { flushSessionWrites, useCrypto } from './hooks/useCrypto';
import { devLog } from './utils/devLog';
import { DEBUG_TOOLS } from './utils/debugFlags';
import { useSubscriptionStore } from './stores/subscriptionStore';
import { PaywallModal } from './components/PaywallModal';
import { RemoteScreenViewer } from './components/RemoteScreenViewer';
import { ElectronTitleBar } from './components/ElectronTitleBar';
import { ScreenSourcePicker } from './components/ScreenSourcePicker';
import { mediaChannelService } from './services/mediaChannel';
import { screenShareService } from './services/screenShare';
import { nativeScreenSenderService } from './services/nativeScreenSender';
import { AegisDisplay } from '@aegisrd/capacitor-aegisdisplay';
import { UpgradePage } from './pages/UpgradePage';
import { isScreenSendAllowed } from './services/tierGate';
import { setStatusBar } from './services/capacitor';
import { DeviceLimitGate } from './components/DeviceLimitGate';

export default function App() {
  // /auth/verify 頁面：純驗證確認，不進主流程（也不走 useAuth 的 hooks）
  const isVerifyPath = typeof window !== 'undefined'
    && (window.location.pathname === '/auth/verify' || window.location.pathname === '/auth/verify/');

  if (isVerifyPath) {
    return <VerifyPage />;
  }

  return <AppShell />;
}

function AppShell() {
  const auth = useAuth();
  const isDesktop = useIsDesktop();
  const crypto = useCrypto();  // E2EE: 抄 AegisTalk hook；identity 從 login 注入（見下方 useEffect）
  const { language } = useLanguage();
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showPwReset, setShowPwReset] = useState(false);  // 忘記密碼:magic-link 登入後跳「設新密碼」
  const [mobileTab, setMobileTab] = useState<Tab>('timeline');
  const [mqttState, setMqttState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  /** 開機註冊裝置因網路失敗時遞增 → 重跑開機流程（不再等下次開 App） */
  const [bootRetry, setBootRetry] = useState(0);
  /** 裝置註冊被 API 拒絕（重試不會好的 4xx）的伺服器訊息：顯示在畫面上，不重試（對應 TofuTalk ae21506） */
  const [bootError, setBootError] = useState<string | null>(null);
  // Phase C：register 撞 409 時暫停 boot，全螢幕 gate 取代 main app
  const [deviceGate, setDeviceGate] = useState<{
    tier: string;
    tierLimit: number;
    devices: Device[];
    currentDeviceId: string | null;
  } | null>(null);
  const presence = useDevicePresence(auth.devices, auth.currentDeviceId);

  // 帳號名冊 ping（別台加入/重連宣告「我在這」）→ 立即重抓裝置清單，事件驅動秒收斂，
  // 不用等 useAuth 的 20s 輪詢（輪詢保留當漏接備援）。補上「presence 綁 pubkey、無法發現
  // 未知新裝置」的架構缺口。
  useEffect(() => {
    if (!auth.user) return;
    return mqttService.onRosterChanged(() => { void auth.refreshDevices(); });
  }, [auth.user, auth.refreshDevices]);

  // === 「仍是本帳號裝置」檢查（稽核 B1）：配對、MQTT 金鑰訊息、WebRTC offer、入站內容共用。
  //     放在配對 handler 註冊之前；名冊 ping（含撤銷後的公告）時下一次檢查立刻重抓清單。 ===
  //     上一份成功的清單存在本機（只有公鑰）：冷啟動時 API 掛著也認得自己的裝置（對應 TofuTalk 06fe74a）。
  const accountUserId = auth.user?.id ?? null;
  useEffect(() => {
    if (!auth.jwt || !accountUserId) return;
    const jwt = auth.jwt;
    setAccountDeviceCheck(accountDeviceCheck(async () => {
      const devices = await listDevices(jwt);
      if (devices.length === 0) throw new Error('device list unavailable');   // 帳號至少有這台
      return devices.filter((d) => d.pubkey).map((d) => d.pubkey as string);
    }, accountDevicePersistence(accountUserId)));
    const unsubscribe = mqttService.onRosterChanged(() => invalidateAccountDevices());
    return () => { unsubscribe(); setAccountDeviceCheck(null); };
  }, [auth.jwt, accountUserId]);

  // === Identity bootstrap（2026-06：隨機身分，AegisTalk 式）===
  //   1) reload 後 encKey 只活在記憶體、重載就沒了 → 從 IndexedDB 快取還原
  //      （restoreEncryptionKeyFromSession，靠 sessionStorage marker，同 tab 重載有效）
  //   2) encKey 到位 → unlockAndReloadKeys 解出已存的隨機身分；沒有（新裝置）就
  //      generateIdentity()（隨機，存加密）
  //   3) 還沒 encKey（等密碼登入 / onboard 設密碼）→ 先 bail，hasPassword 變化會重觸發
  //   鏡像 AegisTalk AppProvider gate：!identity && getEncryptionKey() 才生 / 解。
  const idBootRef = useRef(false);
  useEffect(() => {
    if (!auth.user) { idBootRef.current = false; return; }  // 登出 → 重置,下次登入重跑 bootstrap
    if (!crypto.initialized || crypto.identity) return;
    if (idBootRef.current) return;
    idBootRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        // reload 情境：encKey 不在記憶體 → 從快取還原（沒有就維持 null）
        if (!getEncryptionKey()) {
          await restoreEncryptionKeyFromSession().catch(() => false);
        }
        if (cancelled) return;
        if (!getEncryptionKey()) {
          // 沒鑰匙不生身分（避免 ephemeral）。冷啟動時 encKey(綁 sessionStorage marker)隨進程
          // 關閉消失 → useCrypto.initialize 偵測「有加密 keys 但解不開」會把 crypto.keysLocked 設 true,
          // render 直接用 crypto.keysLocked 顯示解鎖畫面(比照 AegisTalk 用 keysLocked gate,
          // 不自造 state)。新使用者(還沒生身分)keysLocked=false,維持原樣等密碼登入/onboard。
          idBootRef.current = false;
          return;
        }
        const unlocked = await crypto.unlockAndReloadKeys();
        if (cancelled) { idBootRef.current = false; return; }
        if (unlocked) {
          devLog('[App] Unlocked existing random identity from storage');
        } else {
          crypto.generateIdentity();  // 隨機（新裝置 / 砍帳號重註冊後）
          devLog('[App] Generated new random identity');
        }
        // 成功後 idBootRef 留 true：crypto.identity 一 set，上方 guard 防重入
      } catch (err) {
        console.error('[App] Identity bootstrap failed:', err);
        idBootRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [auth.user, crypto.initialized, crypto.identity, auth.hasPassword, crypto.unlockAndReloadKeys, crypto.generateIdentity]);

  // === Device pairing：identity ready 後註冊 MQTT handlers，
  //     對所有同帳號 peer 發 PREKEY_REQUEST → 收 PRE_KEY_BUNDLE → X3DH。
  //     AegisTrans-specific（取代 AegisTalk 的 invite code 加好友流程）。
  //     X3DH 完成後 → onSessionEstablished → 僅 lexicographically-smaller pubkey 側 dispatchGroupKeyTo
  //     （避免雙向 race 導致兩邊 active key 互相覆蓋 → aead::Error）。 ===
  useEffect(() => {
    if (!crypto.identity || !auth.user) return;
    const userId = auth.user.id;
    const myPk = crypto.identity.publicKeyBase64;
    registerCryptoFunctions({
      getPreKeyBundleData: crypto.getPreKeyBundleData,
      createSession: crypto.createSession,
      acceptSession: crypto.acceptSession,
      hasSessionWith: crypto.hasSession,
      flushSessionWrites,
      onSessionEstablished: (peerPk) => {
        // 一律 dispatch 自己當前 active group key — 不再用 lex-smaller pubkey tiebreaker。
        // 原 tiebreaker 設計假設「最小 pubkey 全域 dispatcher」,但當該裝置離線時
        // 整 group 卡死(沒人派 key,其他 peer 全在等)。改成每個 X3DH session 雙邊
        // 都 dispatch 自己的 active key,handleKeyDistribution at receiver 用 keyId 去重。
        // 收方有對方 key + 自己 key,兩邊都能 decrypt 對方訊息。
        dispatchGroupKeyTo(userId, peerPk, myPk, crypto.encrypt);
      },
    }, myPk);
    initDevicePairing();
    return () => {
      shutdownDevicePairing();
      unregisterCryptoFunctions();
    };
  }, [crypto.identity, crypto.getPreKeyBundleData, crypto.createSession, crypto.acceptSession, crypto.hasSession, crypto.encrypt, auth.user]);

  // === Group Key：identity ready → 註冊 sign/verify。
  //     active key 由 dispatcher（lex-smaller pubkey）在 onSessionEstablished
  //     時 lazily 生成 + 分發；非 dispatcher 等對方來。 ===
  useEffect(() => {
    if (!crypto.identity) return;
    const identity = crypto.identity;
    groupKeyService.registerSignFunctions({
      sign: (data: Uint8Array) => identity.sign(data),
      verify: (pubKey, data, sig) => Identity.verify(pubKey, data, sig),
    });
  }, [crypto.identity]);

  // === Group Key Rotation on Device Revoke ===
  //     useAuth.revokeDevice 完成後 fire window event，這裡接到 → rotate group
  //     key + dispatch 給剩餘裝置。被撤的裝置因為沒收到新 key，無法解密之後內容。
  useEffect(() => {
    if (!crypto.identity || !auth.user) return;
    const userId = auth.user.id;
    const myPk = crypto.identity.publicKeyBase64;
    const jwt = auth.jwt;
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        revokedDeviceId: string;
        revokedPubkey: string | null;
        remainingPubkeys: string[];
      };
      try {
        // 剩餘裝置以伺服器為準（撤銷已生效）：React 的 devices 可能還沒載入或已過期 → 新 key 送給沒人（稽核 B1）
        invalidateAccountDevices();
        const fromServer = jwt
          ? await listDevices(jwt).then((list) => list.filter((d) => d.pubkey).map((d) => d.pubkey as string)).catch(() => null)
          : null;
        const peers = (fromServer ?? detail.remainingPubkeys).filter((pk) => pk !== myPk && pk !== detail.revokedPubkey);
        // 被撤的那台交來的 key（例如先塞的未來時間 key）不再算 active，新的輪換 key 才是唯一的錨點（稽核 B11，對應 TofuTalk 8e3b49d）
        await groupKeyService.observeAccountDevices([...peers, myPk]);
        await rotateGroupKeyAndDispatch(userId, myPk, peers, crypto.encrypt);
        devLog('[App] Group key rotated after device revoke; dispatched to', peers.length, 'peers');
        // 其他裝置立刻重抓清單：配對、offer、金鑰訊息不再放行被撤的那台；本機也不再對它廣播
        mqttService.announceRosterChange();
        if (fromServer) pruneToAccountPeers([...fromServer, myPk]);

        // 清掉該裝置的 outbox + P2P 連線（避免「待傳給已撤銷裝置的訊息卡 30 天」）
        if (detail.revokedPubkey) {
          const cleared = await clearOutboxForPeer(detail.revokedPubkey);
          disconnectPeer(detail.revokedPubkey);
          devLog(`[App] Cleared ${cleared} outbox messages + disconnected revoked peer ${detail.revokedPubkey.slice(0, 16)}`);
        }
      } catch (err) {
        console.error('[App] rotateGroupKeyAndDispatch failed:', err);
      }
    };
    window.addEventListener('aegistrans:deviceRevoked', handler);
    return () => window.removeEventListener('aegistrans:deviceRevoked', handler);
  }, [crypto.identity, crypto.encrypt, auth.user, auth.jwt]);

  // === PreKey Rotation：identity ready 後啟動服務。
  //     Phase 1 收尾項目 D：service 是 SPK / OTP 的單一 source of truth；
  //     useCrypto.acceptSession + getPreKeyBundleData 都改走 service。
  //     若是「fork 後已 dogfood、useCrypto state 有 SPK/OTPs」的 user，先把 state
  //     seed 進 service store（避免 service.initialize 生新 keys → 跟對端 ratchet
  //     不一致 → aead::Error）。
  useEffect(() => {
    if (!crypto.identity) return;
    const identity = crypto.identity;
    let cancelled = false;
    (async () => {
      try {
        // Migration: useCrypto 既有 state 種子化 service store
        if (crypto.signedPreKey && crypto.oneTimePreKeys.length > 0) {
          await preKeyRotationService.seedFromUseCrypto(
            identity,
            crypto.signedPreKey,
            crypto.oneTimePreKeys,
          );
        }
        if (cancelled) return;
        await preKeyRotationService.initialize(identity);
        if (cancelled) return;
        const status = preKeyRotationService.getStatus();
        // 用 console.error 確保 production build 看得到（devLog 在 prod 會被 dead-code-eliminate）
        console.error('[PreKeyRotation:init] signedPreKey age:',
          status.signedPreKey.ageInDays, 'd, OTPs:',
          status.oneTimePreKeys.available, '/', status.oneTimePreKeys.total,
          'healthy:', status.healthy);
        // e2e debug hook（CR-06/H-07：只在 dogfood/e2e build 曝露）
        if (DEBUG_TOOLS) {
          const w = window as unknown as { __aegisDebug?: Record<string, unknown> };
          w.__aegisDebug = w.__aegisDebug || {};
          w.__aegisDebug.preKeyRotation = () => preKeyRotationService.getStatus();
        }
      } catch (err) {
        console.error('[App] PreKeyRotation init failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      preKeyRotationService.shutdown();
    };
  }, [crypto.identity]);

  // === ENCRYPTED_MESSAGE 接收：解密後分流（目前只認 group_key_distribution） ===
  // 注意：早期 race — 對方寄 group key dispatch（session 第一個 ratchet message）時，
  // 我這邊的 X3DH 可能還沒處理完，hasSession 還是 false。直接 drop 會造成永遠拿不到 group key
  // → encrypted_text 全部 decrypt 失敗。改成「queue 起來等 session ready 再 retry」。
  const pendingEncryptedMessagesRef = useRef<Map<string, MqttMessage[]>>(new Map());
  // ratchet desync(persistent aead) 自癒：每 peer 上次發起 repair 的時間,避免 repair 風暴(30s cooldown)。
  const repairCooldownRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!crypto.identity || !auth.user || !auth.jwt) return;
    const userId = auth.user.id;
    const jwt = auth.jwt;
    const processMessage = async (message: MqttMessage): Promise<boolean> => {
      // 回傳 true = 處理完成或永久失敗（不 retry）；false = 暫存等 retry
      try {
        const senderPk = message.from;
        // 被撤銷的裝置手上還有舊 session：它送來的金鑰分發不能收（否則能把自己的 key 設成 active），稽核 B1
        //   roster ping 之後要等清單確認（strict）：其他入口照快取回答，金鑰不行（對應 TofuTalk afc85e8，AegisTrans 審查 C）
        if (!(await isConfirmedAccountDevice(senderPk))) {
          diagLog(`[DIAG:enc-mqtt] DROP from non-account device=${senderPk.slice(0, 16)}`);
          return true;
        }
        if (!crypto.hasSession(senderPk)) {
          diagLog(`[DIAG:enc-mqtt] QUEUE no-session yet from=${senderPk.slice(0, 16)}`);
          return false;
        }
        const ratchet = RatchetMessage.fromJson(message.payload as string);
        const plaintext = await crypto.decrypt(senderPk, ratchet);
        const data = JSON.parse(plaintext) as { type?: string };
        if (data.type === 'group_key_distribution') {
          // 只收「我的裝置」群組的 key（稽核 B11：以前任何 groupId 都收）
          if ((data as unknown as groupKeyService.GroupKeyDistribution).groupId !== myDevicesGroupId(userId)) {
            diagLog(`[DIAG:enc-mqtt] DROP group_key for another group from=${senderPk.slice(0, 16)}`);
            return true;
          }
          await groupKeyService.handleKeyDistribution(data as unknown as groupKeyService.GroupKeyDistribution, senderPk);
          diagLog(`[DIAG:enc-mqtt] OK group_key from=${senderPk.slice(0, 16)}`);
          // 新 group key 到貨 → 重試之前因沒這把 key 而 buffer 的訊息（第一則競態自動補上，不用重登）
          const newKeyId = (data as unknown as groupKeyService.GroupKeyDistribution).keyId;
          if (newKeyId) void retryPendingForKey(newKeyId);
          return true;
        }
        if (data.type === 'group_key_request') {
          const req = data as unknown as groupKeyService.GroupKeyRequest;
          const expectedGroupId = myDevicesGroupId(userId);
          if (!req.keyId || req.groupId !== expectedGroupId) {
            diagLog(`[DIAG:enc-mqtt] DROP bad group_key_request from=${senderPk.slice(0, 16)}`);
            return true;
          }

          // 清單抓不到 → 當成沒授權（寧可不給金鑰），請求端 25 秒後會再要
          const devices = await listDevices(jwt).catch(() => []);
          const requesterStillAuthorized = devices.some((d) => d.pubkey === senderPk);
          if (!requesterStillAuthorized) {
            diagLog(`[DIAG:enc-mqtt] DENY group_key_request from non-device=${senderPk.slice(0, 16)} keyId=${req.keyId.slice(0, 12)}`);
            return true;
          }

          const sent = await dispatchGroupKeyByIdTo(userId, req.keyId, senderPk, crypto.encrypt);
          diagLog(`[DIAG:enc-mqtt] group_key_request keyId=${req.keyId.slice(0, 12)} from=${senderPk.slice(0, 16)} sent=${sent}`);
          return true;
        }
        diagLog(`[DIAG:enc-mqtt] unknown type=${data.type} from=${senderPk.slice(0, 16)}`);
        return true;
      } catch (err) {
        const emsg = (err as Error)?.message || String(err);
        diagLog(`[DIAG:enc-mqtt] FAILED ${emsg}`);
        // F4 自癒：ratchet desync(aead) → 發起 authoritative 重新配對(雙邊重建 fresh session →
        // 重新 dispatch group key),免使用者重登。只對 aead/decrypt 類錯誤,且每 peer 30s cooldown
        // 避免風暴(fresh session 不該再 aead,所以正常只觸發一次)。
        if (/aead|decrypt/i.test(emsg)) {
          const senderPk = message.from;
          const now = Date.now();
          if (now - (repairCooldownRef.current.get(senderPk) ?? 0) > 30_000) {
            repairCooldownRef.current.set(senderPk, now);
            diagLog(`[DIAG:enc-mqtt] ratchet desync → requestRepairWith ${senderPk.slice(0, 16)}`);
            requestRepairWith(senderPk);
          }
        }
        return true; // 這一則丟掉；重配對完成後對方會重新 dispatch group key
      }
    };
    const drainQueueFor = async (peerPk: string) => {
      const queue = pendingEncryptedMessagesRef.current.get(peerPk);
      if (!queue || queue.length === 0) return;
      diagLog(`[DIAG:enc-mqtt] DRAIN ${queue.length} queued for ${peerPk.slice(0, 16)}`);
      pendingEncryptedMessagesRef.current.delete(peerPk);
      for (const m of queue) {
        const done = await processMessage(m);
        if (!done) {
          // 還是不行 — 重新塞回 queue（不太可能）
          const q = pendingEncryptedMessagesRef.current.get(peerPk) ?? [];
          q.push(m);
          pendingEncryptedMessagesRef.current.set(peerPk, q);
          break;
        }
      }
    };
    // hasSession 變 true 時清空 queue（每秒輪詢；簡單但夠用）
    const drainInterval = setInterval(() => {
      pendingEncryptedMessagesRef.current.forEach((_q, peerPk) => {
        if (crypto.hasSession(peerPk)) {
          void drainQueueFor(peerPk);
        }
      });
    }, 1000);

    const unsub = mqttService.onMessage(MessageType.ENCRYPTED_MESSAGE, async (message: MqttMessage) => {
      try {
        const done = await processMessage(message);
        if (!done) {
          // queue
          const senderPk = message.from;
          const q = pendingEncryptedMessagesRef.current.get(senderPk) ?? [];
          q.push(message);
          pendingEncryptedMessagesRef.current.set(senderPk, q);
        }
      } catch (err) {
        console.error(`[App] ENCRYPTED_MESSAGE handler failed: ${(err as Error)?.message || String(err)}`);
      }
    });
    return () => {
      clearInterval(drainInterval);
      unsub();
    };
  }, [crypto.identity, crypto.decrypt, crypto.encrypt, crypto.hasSession, auth.user, auth.jwt]);

  // 對所有有 pubkey 且非自己的裝置發起 device pairing（PREKEY_REQUEST）
  // 同上：filter by pubkey 避免 currentDeviceId race condition 把自己也送 PREKEY_REQUEST。
  useEffect(() => {
    if (!crypto.identity || !auth.devices.length) return;
    const myPubkey = crypto.identity.publicKeyBase64;
    const peerPubkeys = auth.devices
      .filter((d) => d.pubkey && d.pubkey !== myPubkey)
      .map((d) => d.pubkey as string);
    // 清單上沒有的 peer（別台撤銷的、重裝換 key 的）不再廣播、斷線（稽核 B10）
    pruneToAccountPeers([...peerPubkeys, myPubkey]);
    if (peerPubkeys.length === 0) return;
    requestPairingWithMany(peerPubkeys);
  }, [crypto.identity, auth.devices]);

  // 給已不在清單上的裝置的 outbox：每次成功抓到清單都看一次，連續 24 小時都沒有它才清
  //   （對應 TofuTalk a08cc93、c0fe806；AegisTrans 審查 D）。自己撤銷的那台由上面的撤銷流程立刻清。
  //   群組金鑰的 active 集合也跟著清單重算：不在帳號上的裝置交來的 key 立刻不算（可回復，不用等兩次；對應 TofuTalk 8e3b49d）。
  //   「仍是本帳號裝置」檢查的快取也吃這些清單（useAuth 每 20 秒一次）：答案最多舊 ~20 秒，不多打 API（對應 TofuTalk aaaf536，審查 LOW-4）。
  useEffect(() => onDeviceListFetched((devices, { startedAt }) => {
    const pubkeys = devices.filter((d) => d.pubkey).map((d) => d.pubkey as string);
    observeFetchedDeviceList(pubkeys, startedAt);
    void observeAccountDeviceList(pubkeys);
    void groupKeyService.observeAccountDevices(pubkeys);
  }), []);

  // === Lifecycle: 等隨機 identity ready → 註冊/dedupe device → MQTT connect ===
  useEffect(() => {
    if (!auth.user || !auth.jwt) return;
    if (!crypto.identity) return;  // 等 identity bootstrap effect 生成/解鎖隨機身分
    if (deviceGate) return;  // gate 開著 → 暫停 boot；gate 解掉後此 effect 重跑

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const retryNow = () => setBootRetry((n) => n + 1);
    (async () => {
      try {
        // 1) 用已生成/解鎖的隨機身分（上方 identity bootstrap effect 負責）
        const identity = crypto.identity!;

        // 1.5) 派生 deviceId from fingerprint（同硬體 → 同 deviceId → 同 MQTT clientId）
        //    必須在 mqttService.connect 之前呼叫，因為 mqtt.ts 用 getDeviceIdSync() 讀
        //    localStorage。若沒先 ensure，clientId 會用 'default' fallback。
        const { ensureDeviceId } = await import('./services/deviceId');
        await ensureDeviceId();
        if (cancelled) return;

        // 2) 註冊裝置（帶 pubkey + fingerprint_hash）— 後端 dedupe by
        //    (user_id, fingerprint_hash) 主鍵；fallback (user_id, pubkey)。
        //    同物理機跨 pm clear / 重裝都對到同一個 row。
        const regResult: RegisterDeviceResult = await registerCurrentDevice(auth.jwt!, identity.publicKeyBase64);
        if (cancelled) return;
        if (!regResult.ok) {
          if (regResult.reason === 'device_limit_exceeded') {
            // 真的超過 tier 上限（無法 dedupe）→ 顯示 gate，取代 main app
            setDeviceGate({
              tier: regResult.tier,
              tierLimit: regResult.tierLimit,
              devices: regResult.devices,
              currentDeviceId: regResult.currentDeviceId,
            });
            return;
          }
          if (regResult.reason === 'hard_cap') {
            console.error('[App] Hard device cap hit:', regResult.message);
            // 硬上限 16 — 走相同 gate（讓 user 撤一台），但 message 不同
            return;
          }
          if (regResult.reason === 'revoked') {
            // API 自己的撤銷回應（跟 session 檢查同一套規則）：這台已被撤銷 → 登出，不再重試
            console.error('[App] registerCurrentDevice: this device/session was revoked → signing out');
            auth.signOut();
            return;
          }
          if (regResult.reason === 'expired') {
            // session 的 30 天效期過了（伺服器回 401 "Invalid or expired token"）：過期的 JWT 不會再被接受 → 登出，不再重試（對應 TofuTalk 749e349，審查 HIGH-1）
            devLog('[App] registerCurrentDevice: the session expired → signing out');
            auth.signOut();
            return;
          }
          if (regResult.reason === 'rejected') {
            // 其他 4xx：重試也不會好 → 顯示錯誤、不重試（對應 TofuTalk ae21506：以前當成網路錯每分鐘重試）
            console.error('[App] registerCurrentDevice rejected:', regResult.message);
            setBootError(regResult.message);
            return;
          }
          // network 錯（連不到、逾時、5xx、429、非撤銷的 401、代理／WAF 不是 JSON 的錯誤頁）：排定重試（5s→10s→…→60s），網路恢復時立刻重試。
          //   以前只等下次開機 → 開 App 當下沒網路，之後整段時間沒有 MQTT／P2P、送訊息一直失敗
          const delay = Math.min(60_000, 5_000 * 2 ** Math.min(bootRetry, 4));
          devLog('[App] registerCurrentDevice network error, retrying in', delay, 'ms');
          retryTimer = setTimeout(retryNow, delay);
          window.addEventListener('online', retryNow, { once: true });
          return;
        }

        setBootError(null);

        // 3) 同步 React state（refresh 後 devices + currentDeviceId 都會對齊）
        await auth.refreshDevices();
        if (cancelled) return;

        // 4) 連 MQTT broker — **不可 await**。重登時舊連線可能卡在「already in progress」
        //    永不 resolve（mqtt.ts connect guard 回同一個 stuck promise）→ await 會 hang →
        //    後面的 mqttHealthMonitor.start() 跟 initPeerSync() 永遠跑不到 → 一傳訊息就
        //    「PeerSync not initialized」、完全傳不出。改 fire-and-forget：連線在背景進行，
        //    下方 health monitor 會偵測卡住/死掉的 socket 自動 forceReconnect。
        void mqttService.connect(identity.publicKeyBase64, false, auth.user!.id).catch((e) =>
          devLog('[App] MQTT connect error (health monitor will retry):', (e as Error)?.message));
        devLog('[App] MQTT connect requested for', identity.publicKeyBase64.slice(0, 12) + '...');

        // 4.5) 啟動 MQTT health monitor — 偵測 dead socket / 殭屍連線 / OS 殺 socket,
        //      自動 forceReconnect。沒啟動的話對方看我永遠 offline (LWT retained 沒被覆寫)。
        mqttHealthMonitor.start();

        // 5) 啟動 peerSync（WebRTC + 訊息監聽）
        const myDeviceId = (await import('./services/auth')).getCurrentDeviceId();
        if (myDeviceId) {
          initPeerSync({
            localPubkeyBase64: identity.publicKeyBase64,
            currentDeviceId: myDeviceId,
            userId: auth.user!.id,
            requestMissingGroupKey: (peerPubkey, keyId) => {
              void requestGroupKeyFrom(auth.user!.id, peerPubkey, keyId, crypto.encrypt).catch((err) => {
                diagLog(`[DIAG:recv] REQUEST group-key send failed keyId=${keyId.slice(0, 12)} err=${(err as Error)?.message || String(err)}`);
              });
            },
          });

          // 5.5) Phase 2 跨裝置媒體：mediaChannel 訂閱 webrtc.onMediaStream，
          //      screenShare 訂閱 SCREEN_SHARE_OFFER/ANSWER/END/REJECT。idempotent。
          mediaChannelService.initialize();
          screenShareService.initialize();

          // 6) 直接從後端拉最新 device 列表 → 對所有非自己且有 pubkey 的裝置 connect
          //    （不依賴 React state 同步，避免 race）
          // 抓不到就這輪不主動連（roster ping／presence 上線時還會再連）
          const allDevices = await listDevices(auth.jwt!).catch(() => []);
          if (cancelled) return;
          const peerPubkeys = allDevices
            .filter((d) => d.id !== myDeviceId && d.pubkey)
            .map((d) => d.pubkey as string);
          if (peerPubkeys.length > 0) {
            void connectToPeers(peerPubkeys);
            devLog('[App] Initiating WebRTC to peers:', peerPubkeys.length);
          }
        }
      } catch (err) {
        console.error('[App] Identity / device / MQTT bootstrap failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('online', retryNow);
    };
  }, [auth.user, auth.jwt, auth.refreshDevices, deviceGate, crypto.identity, crypto.encrypt, bootRetry]);

  // 對所有有 pubkey 且非自己的裝置發起 WebRTC P2P 連線
  // （MQTT presence 變化時，useDevicePresence 已 subscribe；這裡只負責 connect）
  // 改 filter by pubkey（不靠 deviceId）— 避免 boot 早期 currentDeviceId 還是 null 時
  // filter 失效，把自己加進 peer set 導致 self-loop 廣播。
  useEffect(() => {
    if (!auth.devices.length) return;
    const myPubkey = crypto.identity?.publicKeyBase64;
    if (!myPubkey) return;  // identity 還沒準備好就不要連，否則 filter 會失效
    const peerPubkeys = auth.devices
      .filter((d) => d.pubkey && d.pubkey !== myPubkey)
      .map((d) => d.pubkey as string);
    if (peerPubkeys.length === 0) return;
    void connectToPeers(peerPubkeys);
  }, [auth.devices, crypto.identity]);

  // 監聽 MQTT 連線狀態
  useEffect(() => {
    const unsub = mqttService.onStateChange((state) => {
      setMqttState(state);
      // MQTT(重)連上的那一刻 → 立刻補一次 P2P 健康檢查。MQTT 剛斷又回時 P2P 很可能也死了,
      // 不必等下一個 watchdog tick(peerHealthMonitor 內部仍 gate 在 isConnected())。
      if (state === ConnectionState.CONNECTED) peerHealthMonitor.probeNow();
    });
    return unsub;
  }, []);

  // 登出時斷開 MQTT + 清 identity 快取 + 關閉 peerSync / mediaChannel / screenShare
  useEffect(() => {
    if (!auth.user) {
      mqttHealthMonitor.stop();
      if (mqttState === ConnectionState.CONNECTED) {
        mqttService.disconnect();
      }
      shutdownPeerSync();
      screenShareService.shutdown();
      mediaChannelService.shutdown();
      clearIdentity();
    }
  }, [auth.user, mqttState]);

  // Phase 3.X: Electron graceful-shutdown hook — main process before-quit asks
  // us to publish presence=false + teardown MQTT before TCP socket closes,
  // so peers see us offline within ~1s instead of waiting 30-90s for broker LWT.
  useEffect(() => {
    const electron = (window as unknown as { aegisElectron?: { onGracefulShutdown?: (cb: () => void) => () => void; notifyShutdownDone?: () => void } }).aegisElectron;
    if (!electron?.onGracefulShutdown || !electron?.notifyShutdownDone) return;
    const unsub = electron.onGracefulShutdown(() => {
      void (async () => {
        try {
          await mqttService.gracefulShutdown(1500);
        } catch (err) {
          console.error('[App] gracefulShutdown threw:', err);
        } finally {
          electron.notifyShutdownDone?.();
        }
      })();
    });
    return unsub;
  }, []);

  // Wire mqttHealthMonitor 的 visibility + network 事件 — 切前景立即 probe,
  // network 恢復也立即 probe。Capacitor Electron 環境 visibility 事件較少 fire,
  // 但 network online/offline 可靠 (mobile / wifi 切換 / sleep)。
  useEffect(() => {
    const onVisibility = () => {
      mqttHealthMonitor.onVisibilityChange(!document.hidden);
      peerHealthMonitor.onVisibilityChange(!document.hidden);
    };
    const onOnline = () => {
      mqttHealthMonitor.onNetworkChange(true);
      peerHealthMonitor.onNetworkChange(true);
    };
    const onOffline = () => {
      mqttHealthMonitor.onNetworkChange(false);
      peerHealthMonitor.onNetworkChange(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // 原生狀態列：確保 WebView 不延伸到 iPhone 狀態列後方（修「app 太高碰到狀態列」）。
  //   抄 AegisTalk：setOverlaysWebView(false) + 深色樣式。mount 一次即可。
  useEffect(() => {
    void setStatusBar({ style: 'dark', backgroundColor: '#0d1b2a' });
  }, []);

  // 訂閱狀態：登入後拉一次 status + 用量；登出後 reset。
  useEffect(() => {
    if (auth.user && auth.jwt) {
      void useSubscriptionStore.getState().refresh();
    } else {
      useSubscriptionStore.getState().reset();
    }
  }, [auth.user, auth.jwt]);

  // CR-05：登入後啟動 StoreKit Transaction.updates 監聽（iOS 才有作用，其它平台 no-op）。
  //   背景續訂 / 退款 / 跨裝置購買 → 後端 re-verify 成功才 finish + 更新訂閱狀態。
  useEffect(() => {
    if (!(auth.user && auth.jwt)) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('./services/iap').then(({ startIapUpdateListener }) =>
      startIapUpdateListener((status) => { void useSubscriptionStore.getState().setStatus(status); })
        .then((unsub) => { if (cancelled) unsub(); else stop = unsub; })
    );
    return () => { cancelled = true; stop?.(); };
  }, [auth.user, auth.jwt]);

  // Phase C 重構（2026-05-06）：移除「app 內偵測 device 超限就彈 paywall」的 effect。
  //   超限應該在 register 階段（boot useEffect 上方）由 server 回 409 → DeviceLimitGate。
  //   in-app paywall 留給 storage_quota_exceeded 等真的「使用中撞牆」的場景。

  // Phase 2 §6.4：訂閱「對方拒絕」事件 — 顯示提示。
  // ⚠️ 必須放在所有 early return 之前（Rules of Hooks）。
  useEffect(() => {
    return screenShareService.onPeerRejected(() => {
      alert(aegisT(language, 'screenShare.peerRejected'));
    });
  }, [language]);

  // Phase 2（2026-06）：忘記密碼流程 — EmailAuthScreen 在 forgot 模式設了 PW_RESET_FLAG，
  //   magic-link 驗證完成、登入後（auth.user 出現）→ 跳 ResetPasswordOverlay 設新密碼。
  useEffect(() => {
    let flagged = false;
    try { flagged = sessionStorage.getItem(PW_RESET_FLAG) === '1'; } catch { /* ignore */ }
    if (auth.user && flagged) setShowPwReset(true);
  }, [auth.user]);

  if (auth.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-primary text-on-surface-primary">
        <div className="w-10 h-10 border-4 border-mist-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!auth.user) {
    return (
      <EmailAuthScreen
        key="login"
        error={auth.error}
        linkRequestedFor={auth.linkRequestedFor}
        onRequestLink={auth.requestLink}
        onPasswordLogin={auth.loginWithPassword}
        onCancelLinkRequest={auth.cancelLinkRequest}
        onClearError={auth.clearError}
      />
    );
  }

  // CR-07：致命的 crypto/DB 初始化失敗（例：returning user 的 DB 還沒載入，已拒絕覆寫）
  // → 丟給 ErrorBoundary 顯示訊息 + Reload 按鈕，不要用半套狀態 render 主畫面（會看到空/壞畫面）。
  // crypto.error 只在 useCrypto.initialize() 的 catch 設定 = 真正致命的初始化失敗。
  if (crypto.error) throw crypto.error;

  // 冷啟動:JWT 還在(看似登入)但 crypto.keysLocked(有加密 keys、encKey 沒撐過進程重啟)→
  // 顯示登入頁重新輸密碼解鎖,不要顯示「假在線」聊天(presence 發不出、兩台互看 offline)。
  // 比照 AegisTalk 用既有 keysLocked gate(AppProvider/AuthScreen/ChatApp 都靠它),不自造 state。
  // email 預填,使用者只需輸密碼;loginWithPassword 後端先驗密碼(安全)→ 設 encKey → bootstrap
  // 解鎖身分 → keysLocked 變 false → 進主畫面。
  if (crypto.keysLocked) {
    // encKey 已在記憶體(剛登入 / 剛設密碼,解鎖即將自動完成)→ 顯示「同步中」loading,**不要**顯示
    // 「重輸密碼」畫面,否則登入後會看到又一個登入畫面、以為卡住(2026-07-15 使用者回報)。
    // encKey 不在(冷啟動 returning user、encKey 沒撐過進程重啟)才真的需要重輸密碼。
    if (getEncryptionKey() !== null) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-surface-primary text-on-surface-primary">
          <SyncingIndicator />
        </div>
      );
    }
    return (
      <EmailAuthScreen
        key="unlock"
        error={auth.error}
        linkRequestedFor={auth.linkRequestedFor}
        onRequestLink={auth.requestLink}
        onPasswordLogin={auth.loginWithPassword}
        onCancelLinkRequest={auth.cancelLinkRequest}
        onClearError={auth.clearError}
        defaultEmail={auth.user.email}
        lockedNotice
      />
    );
  }

  // Phase C：register 撞 409 → 全螢幕 gate（取代 main UI），直到使用者撤一台 / 升級 / 取消
  if (deviceGate) {
    return (
      <DeviceLimitGate
        email={auth.user.email}
        jwt={auth.jwt!}
        pubkey={crypto.identity?.publicKeyBase64 ?? null}
        tier={deviceGate.tier}
        tierLimit={deviceGate.tierLimit}
        devices={deviceGate.devices}
        currentDeviceId={deviceGate.currentDeviceId}
        onResolved={() => setDeviceGate(null)}
        onUpgrade={() => { setShowUpgrade(true); }}
        onCancel={() => { setDeviceGate(null); auth.signOut(); }}
      />
    );
  }

  const mqttConnected = mqttState === ConnectionState.CONNECTED;

  // 首次登入（或一直沒設密碼）→ 強制 onboarding 設密碼，無法跳過。
  //（忘記密碼重設優先 — 避免兩個 overlay 疊在一起）
  const showPasswordOnboard = auth.hasPassword === false && !showPwReset;

  /**
   * Phase 2 §6.4：投放螢幕 handler — 從 DeviceListSidebar row 觸發
   *
   * 流程：
   *   1. Pro tier gate（free → 跳 UpgradePage，不執行 capture）
   *   2. AegisDisplay.captureScreen() — 跨平台螢幕擷取（web fallback = getDisplayMedia）
   *   3. screenShareService.startSharing(stream, peerPubkey) — addTrack + SDP 重新協商 + 送 OFFER
   *   4. Receiver 端收到 OFFER → 跳 accept/reject 對話框（RemoteScreenViewer 處理）
   *
   * 失敗 / 取消行為：
   *   - getDisplayMedia 取消：null 回傳，silent
   *   - PC 沒連：throw，alert 提示
   *   - peer 拒絕：screenShareService 內部 handleIncomingReject 會 fire onPeerRejected listener
   */
  const handleShareScreen = async (peerPubkeyBase64: string): Promise<void> => {
    // 1) Pro tier gate（投放 cast）— 與延伸 extend 共用 isScreenSendAllowed()
    if (!isScreenSendAllowed()) {
      // 免費版 → 開升級頁（沿用既有 UpgradePage flow）
      setShowUpgrade(true);
      return;
    }

    // 1.2) 行動端(iOS/Android)：螢幕擷取必須走原生(WebView 不能注入原生 track 到 JS PC)。
    //      原生在獨立進程(iOS Broadcast Extension)跑 video PC,JS 只做 MQTT 信令橋接。
    //      不走下面的 getDisplayMedia + screenShareService.startSharing(那是桌面/web 路徑)。
    if (nativeScreenSenderService.isSupported()) {
      try {
        await nativeScreenSenderService.start(peerPubkeyBase64);
        devLog('[App] native screen send started to', peerPubkeyBase64.slice(0, 12));
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        console.error('[App] nativeScreenSenderService.start failed:', err);
        alert(aegisT(language, 'screenShare.captureFailed') + msg);
      }
      return;
    }

    // 1.5) Defensive: 若還在分享(可能 macOS 系統 indicator 停止沒 fire track ended),
    //      自動先 stopSharing 清狀態,再開新一輪。避免「Already sharing — stop first」
    //      迫使用戶關 .app 重啟。
    if (screenShareService.isSharing()) {
      devLog('[App] handleShareScreen: previous share still active, auto-stopping first');
      await screenShareService.stopSharing();
    }

    // 2) Capture screen（user gesture 必須在 await 第一個 await 之前才有效，所以這個 handler
    //    是同步啟動的；caller [DeviceListSidebar handleShare] 是從 onClick 直接 await 過來，
    //    OK）
    let captureResult;
    try {
      captureResult = await AegisDisplay.captureScreen({ preferredSurface: 'monitor' });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error('[App] AegisDisplay.captureScreen failed:', err);
      alert(aegisT(language, 'screenShare.captureFailed') + msg);
      return;
    }
    if (!captureResult) {
      // user 在 OS dialog 取消 — silent
      devLog('[App] screen capture cancelled by user');
      return;
    }

    // 3) startSharing — 失敗（如 PC 沒連）throw，rollback 內部會 stop tracks
    try {
      await screenShareService.startSharing(captureResult.stream, peerPubkeyBase64);
      devLog('[App] screen share started to', peerPubkeyBase64.slice(0, 12));
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      console.error('[App] screenShareService.startSharing failed:', err);
      alert(msg.includes('No P2P')
        ? aegisT(language, 'screenShare.notConnected')
        : aegisT(language, 'screenShare.captureFailed') + msg);
      // stream 已經由 screenShareService rollback 內部 stop 過
    }
  };

  return (
    <div className="h-screen bg-surface-primary text-on-surface-primary flex flex-col">
      {/* Phase 2 §6.3：跨平台外觀統一(CLAUDE.md §4)— 只在 Electron 殼 render,
          自畫跨 Mac/Win/Linux 一致的 title bar(min/max/close + drag region)。
          PWA / iOS / Android 環境 component 直接 return null,不影響 layout。*/}
      <ElectronTitleBar />
      {/* 桌面多螢幕投放時的來源選擇器（非 Electron 環境永遠 null）。 */}
      <ScreenSourcePicker />
      <header className="border-b border-[var(--surface-border)] px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] flex items-center justify-between flex-shrink-0 bg-surface-secondary">
        <div className="flex items-center gap-2.5">
          <img src="/logo-transparent.png" alt="AegisTrans" className="w-8 h-8" />
          <h1 className="text-lg font-bold tracking-tight">AegisTrans</h1>
          <span className="text-sm text-on-surface-tertiary hidden md:inline">
            {auth.user.email}
          </span>
        </div>
        <div className="flex items-center gap-2 text-base">
          {/* 桌面：header 顯示「設定」按鈕（沒 bottom-nav）；手機：藏起來，用 bottom-nav 的 tab */}
          <button
            onClick={() => setShowSettings((s) => !s)}
            data-testid="header-settings-toggle"
            className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--surface-border)] hover:bg-surface-tertiary text-sm"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            {showSettings ? aegisT(language, 'app.backToMessages') : aegisT(language, 'app.settings')}
          </button>
          <button
            onClick={auth.signOut}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[var(--surface-border)] hover:bg-surface-tertiary text-sm"
            data-testid="signout-button"
          >
            {/* 登出 icon — 門 + 箭頭 */}
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
            </svg>
            {aegisT(language, 'app.signOut')}
          </button>
        </div>
      </header>
      {bootError && (
        <div role="alert" data-testid="boot-error" className="px-4 py-2 text-sm bg-red-500/10 text-red-600 border-b border-red-500/30 flex-shrink-0">
          {aegisT(language, 'app.registerRejected')} ({bootError})
        </div>
      )}

      {showPasswordOnboard && (
        <PasswordOnboardOverlay
          email={auth.user.email}
          onSetPassword={auth.setPassword}
        />
      )}

      {showPwReset && auth.jwt && (
        <ResetPasswordOverlay
          email={auth.user.email}
          onReset={async (pw) => {
            const ok = await resetPassword(auth.jwt!, pw);
            if (ok) {
              try { sessionStorage.removeItem(PW_RESET_FLAG); } catch { /* ignore */ }
              setShowPwReset(false);
            }
            return ok;
          }}
        />
      )}

      {/* === 依視窗大小只 render 一個版本 === */}
      {isDesktop ? (
        showSettings ? (
          // 注意：不用 `flex`（預設 row direction 會讓 SettingsPage 占自然寬度，留白右半）
          // 用 `flex-1 min-h-0 overflow-y-auto` 讓 SettingsPage 以 block 子元素填滿父寬度（抄 AegisTalk ChatApp.tsx pattern）
          <main className="flex-1 min-h-0 overflow-y-auto">
            <div className="max-w-3xl mx-auto">
              <SettingsPage auth={auth} onBack={() => setShowSettings(false)} onShowUpgrade={() => setShowUpgrade(true)} />
            </div>
          </main>
        ) : (
          <main className="flex flex-1 overflow-hidden">
            <DeviceListSidebar
              devices={auth.devices}
              currentDeviceId={auth.currentDeviceId}
              presence={presence}
              onRevoke={auth.revokeDevice}
              mqttConnected={mqttConnected}
              onShareScreen={handleShareScreen}
              onScreenSendBlocked={() => setShowUpgrade(true)}
            />
            <div className="flex-1 flex flex-col overflow-hidden">
              <Timeline
                userId={auth.user.id}
                currentDeviceId={auth.currentDeviceId}
                devices={auth.devices}
              />
            </div>
          </main>
        )
      ) : (
        <>
          <div className="flex flex-1 overflow-hidden flex-col">
            {mobileTab === 'timeline' && (
              <div className="flex-1 flex flex-col overflow-hidden">
                <Timeline
                  userId={auth.user.id}
                  currentDeviceId={auth.currentDeviceId}
                  devices={auth.devices}
                />
              </div>
            )}
            {mobileTab === 'devices' && (
              <div className="flex-1 overflow-y-auto">
                <DeviceListSidebar
                  devices={auth.devices}
                  currentDeviceId={auth.currentDeviceId}
                  presence={presence}
                  onRevoke={auth.revokeDevice}
                  mqttConnected={mqttConnected}
                  onShareScreen={handleShareScreen}
                  onScreenSendBlocked={() => setShowUpgrade(true)}
                />
              </div>
            )}
            {mobileTab === 'settings' && (
              <div className="flex-1 overflow-y-auto">
                <SettingsPage auth={auth} onBack={() => setMobileTab('timeline')} onShowUpgrade={() => setShowUpgrade(true)} />
              </div>
            )}
          </div>
          <BottomNav active={mobileTab} onChange={setMobileTab} />
        </>
      )}

      {/* 付費升級頁（全螢幕 overlay）*/}
      {showUpgrade && (
        <div className="fixed inset-0 z-40 bg-surface-primary overflow-y-auto" data-testid="upgrade-overlay">
          <UpgradePage onClose={() => setShowUpgrade(false)} />
        </div>
      )}

      {/* Phase 2 §6.5：接收端螢幕分享 viewer — 訂閱 mediaChannel.onRemoteStream +
          screenShareService.onIncomingOffer。收到 SDP offer → 跳 accept/reject 對話框；
          accept 後 stream 抵達 → 全螢幕 video。任何裝置都可當 receiver。 */}
      <RemoteScreenViewer devices={auth.devices} />

      {/* Paywall：撞牆觸發；升級點 = 開 UpgradePage；管理裝置點 = 切到 settings tab */}
      <PaywallModal
        onUpgradeClick={() => setShowUpgrade(true)}
        onManageDevicesClick={() => {
          if (isDesktop) {
            setShowSettings(true);
          } else {
            setMobileTab('settings');
          }
        }}
      />
    </div>
  );
}

interface PasswordOnboardOverlayProps {
  email: string;
  onSetPassword: (password: string, currentPassword: string | null) => Promise<boolean>;
}

/** 首次登入後的「設密碼」全螢幕引導。**強制**，沒有跳過按鈕。 */
function PasswordOnboardOverlay({ email, onSetPassword }: PasswordOnboardOverlayProps) {
  const { language } = useLanguage();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (password.length < 8) { setErr(aegisT(language, 'pwOverlay.tooShort')); return; }
    if (password !== confirm) { setErr(aegisT(language, 'pwOverlay.mismatch')); return; }
    setSubmitting(true);
    setErr(null);
    // PasswordOnboardOverlay = first-time set；不需 current_password
    const ok = await onSetPassword(password, null);
    setSubmitting(false);
    if (!ok) setErr(aegisT(language, 'pwOverlay.failed'));
    // 設定成功 → auth.hasPassword 變 true → onboard 自動隱藏
  };

  return (
    <div className="fixed inset-0 bg-surface-primary/95 backdrop-blur-sm z-50 flex items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="max-w-md w-full bg-surface-secondary border border-[var(--surface-border)] rounded-xl p-6 space-y-4">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-mist-500/20 flex items-center justify-center text-2xl">🔐</div>
          <h2 className="text-lg font-semibold">{aegisT(language, 'pwOverlay.onboardTitle')}</h2>
          <p className="text-xs text-on-surface-tertiary mt-1">{email}</p>
        </div>

        <p className="text-sm text-on-surface-primary leading-relaxed">
          {aegisT(language, 'pwOverlay.onboardHint')}
        </p>

        <PasswordInput
          autoComplete="new-password"
          required
          minLength={8}
          placeholder={aegisT(language, 'pwOverlay.newPlaceholder')}
          value={password}
          onChange={setPassword}
        />
        <PasswordInput
          autoComplete="new-password"
          required
          placeholder={aegisT(language, 'pwOverlay.confirmPlaceholder')}
          value={confirm}
          onChange={setConfirm}
        />

        {err && (
          <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || password.length < 8 || password !== confirm}
          className="w-full py-2.5 rounded bg-mist-500 hover:bg-mist-400
                     disabled:bg-mist-500/40 disabled:cursor-not-allowed
                     text-navy-900 font-medium transition-colors"
        >
          {submitting ? aegisT(language, 'pwOverlay.submitting') : aegisT(language, 'pwOverlay.submit')}
        </button>
      </form>
    </div>
  );
}

interface ResetPasswordOverlayProps {
  email: string;
  onReset: (password: string) => Promise<boolean>;
}

/** 忘記密碼：magic-link 驗證後的「設新密碼」全螢幕引導（不需舊密碼）。 */
function ResetPasswordOverlay({ email, onReset }: ResetPasswordOverlayProps) {
  const { language } = useLanguage();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (password.length < 8) { setErr(aegisT(language, 'pwOverlay.tooShort')); return; }
    if (password !== confirm) { setErr(aegisT(language, 'pwOverlay.mismatch')); return; }
    setSubmitting(true);
    setErr(null);
    const ok = await onReset(password);
    setSubmitting(false);
    if (!ok) setErr(aegisT(language, 'pwOverlay.failed'));
  };

  return (
    <div className="fixed inset-0 bg-surface-primary/95 backdrop-blur-sm z-50 flex items-center justify-center px-6">
      <form onSubmit={handleSubmit} className="max-w-md w-full bg-surface-secondary border border-[var(--surface-border)] rounded-xl p-6 space-y-4">
        <div className="text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-mist-500/20 flex items-center justify-center text-2xl">🔑</div>
          <h2 className="text-lg font-semibold">{aegisT(language, 'pwOverlay.resetTitle')}</h2>
          <p className="text-xs text-on-surface-tertiary mt-1">{email}</p>
        </div>
        <p className="text-xs text-on-surface-tertiary leading-relaxed">
          {aegisT(language, 'pwOverlay.resetHint')}
        </p>
        <PasswordInput autoComplete="new-password" required minLength={8} placeholder={aegisT(language, 'pwOverlay.newPlaceholder')} value={password} onChange={setPassword} />
        <PasswordInput autoComplete="new-password" required placeholder={aegisT(language, 'pwOverlay.confirmPlaceholder')} value={confirm} onChange={setConfirm} />
        {err && (
          <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2">{err}</div>
        )}
        <button type="submit" disabled={submitting || password.length < 8 || password !== confirm}
          className="w-full py-2.5 rounded bg-mist-500 hover:bg-mist-400 disabled:bg-mist-500/40 disabled:cursor-not-allowed text-navy-900 font-medium transition-colors">
          {submitting ? aegisT(language, 'pwOverlay.submitting') : aegisT(language, 'pwOverlay.submit')}
        </button>
      </form>
    </div>
  );
}
