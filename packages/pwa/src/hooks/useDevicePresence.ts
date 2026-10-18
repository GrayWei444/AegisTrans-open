/**
 * useDevicePresence
 *
 * 連接 mqtt.ts 與「我的裝置」的線上狀態。
 *   - 對每個 device.pubkey 訂閱 presence
 *   - 監聽 mqttService.onPresenceChange 同步進 React state
 *   - 自己（currentDeviceId）不訂閱（自己永遠線上）
 *
 * 訂閱動作會在「MQTT 連線狀態變綠」時重跑，避免登入瞬間 MQTT 還沒就位的 race。
 */

import { useEffect, useRef, useState } from 'react';
import { mqttService, ConnectionState } from '../services/mqtt';
import type { Device } from '../services/auth';
import { diagLog } from '../utils/diagLog';

export interface DevicePresenceMap {
  /** key = device.pubkey, value = isOnline */
  [pubkey: string]: boolean;
}

export function useDevicePresence(devices: Device[], currentDeviceId: string | null): DevicePresenceMap {
  const [presence, setPresence] = useState<DevicePresenceMap>({});
  const [mqttReady, setMqttReady] = useState(false);
  const subscribedRef = useRef<Set<string>>(new Set());

  // 監聽 MQTT 連線狀態，CONNECTED 時觸發 subscription effect
  useEffect(() => {
    // 立刻同步當前狀態（onStateChange 只在「變化時」才觸發，不會送 initial）
    setMqttReady(mqttService.getState() === ConnectionState.CONNECTED);

    const unsub = mqttService.onStateChange((state) => {
      const ready = state === ConnectionState.CONNECTED;
      setMqttReady(ready);
      if (!ready) {
        subscribedRef.current.clear();
      }
    });
    return unsub;
  }, []);

  // 訂閱所有 peer 裝置的 presence topic（自己除外）
  // 依賴 mqttReady 確保連線後才訂閱；devices 變化也觸發
  useEffect(() => {
    if (!mqttReady) return;

    const peerPubkeys = devices
      .filter((d) => d.id !== currentDeviceId && d.pubkey)
      .map((d) => d.pubkey as string);

    diagLog(`[DIAG:useDP] effect: peers=${peerPubkeys.length} samples=${peerPubkeys.map((k) => k.slice(0, 12)).join(',')}`);

    const toSubscribe = peerPubkeys.filter((pk) => !subscribedRef.current.has(pk));
    if (toSubscribe.length > 0) {
      mqttService.subscribeToFriendsPresence(toSubscribe);
      toSubscribe.forEach((pk) => subscribedRef.current.add(pk));
    }

    // 同步當前已知的線上狀態（broker 的 retained presence 會立刻送過來）
    const initial: DevicePresenceMap = {};
    for (const pk of peerPubkeys) {
      initial[pk] = mqttService.isFriendOnline(pk);
      diagLog(`[DIAG:useDP] initial pk=${pk.slice(0, 16)} online=${initial[pk]}`);
    }
    setPresence((prev) => ({ ...prev, ...initial }));
  }, [devices, currentDeviceId, mqttReady]);

  // 監聽 presence change
  useEffect(() => {
    diagLog('[DIAG:useDP] listener REGISTERED');
    const unsubscribe = mqttService.onPresenceChange((publicKey, isOnline) => {
      diagLog(`[DIAG:useDP] CALLBACK pk=${publicKey.slice(0, 16)} online=${isOnline}`);
      setPresence((prev) => {
        if (prev[publicKey] === isOnline) {
          diagLog(`[DIAG:useDP] CALLBACK no-change for pk=${publicKey.slice(0, 16)}`);
          return prev;
        }
        diagLog(`[DIAG:useDP] CALLBACK setState pk=${publicKey.slice(0, 16)} -> ${isOnline}`);
        return { ...prev, [publicKey]: isOnline };
      });
    });
    return unsubscribe;
  }, []);

  return presence;
}
