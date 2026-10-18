/**
 * nativeScreenSender — 行動端原生螢幕投放(發送)的 JS 信令控制器
 *
 * iOS(Broadcast Extension)/ Android(MediaProjection)共用。原生負責螢幕擷取 + media
 * RTCPeerConnection;此控制器負責把原生產生的 SDP/ICE 經 MQTT(含 group key 加密)轉給
 * 接收端,並把接收端回來的 answer/ICE 餵回原生套用。JS↔原生用 AegisScreenSend plugin
 * event/method;JS↔接收端用既有 SCREEN_SHARE_* MQTT 信令(transport:'dedicated')。
 *
 * 為何信令在 JS 而非原生:MQTT 連線 + E2E group key 都在主 App JS,不在原生重寫一份。
 * iOS 的握手在使用者剛點投放、主 App 還在前景時完成;連上後原生 extension 自己串流,
 * 主 App 退背景被暫停也沒差(單向投放不需中途 renegotiate)。
 *
 * 流程(sender 端):
 *   start(peer)
 *     → 訂閱 plugin events + 該 peer 的 MQTT SCREEN_SHARE_ANSWER / SCREEN_SHARE_ICE
 *     → AegisScreenSend.startScreenSend({ peerPubkey })
 *   plugin 'screenSendLocalDescription'(offer) → MQTT SCREEN_SHARE_OFFER(transport:dedicated)
 *   plugin 'screenSendIceCandidate'           → MQTT SCREEN_SHARE_ICE
 *   MQTT SCREEN_SHARE_ANSWER(from peer)        → AegisScreenSend.setScreenSendRemoteDescription
 *   MQTT SCREEN_SHARE_ICE(from peer)           → AegisScreenSend.addScreenSendIceCandidate
 *   plugin 'screenSendState' failed/ended      → stop() + 通知接收端 END
 *   stop()                                     → AegisScreenSend.stopScreenSend + MQTT END + 清訂閱
 */

import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { AegisScreenSend } from '@aegisrd/capacitor-aegisdisplay';
import { mqttService, MessageType, type MqttMessage } from './mqtt';
import { devLog, devWarn } from '../utils/devLog';
import { diagLog } from '../utils/diagLog';

type SendStateCallback = (state: string, peerPubkey: string | null) => void;

class NativeScreenSenderService {
  private currentPeer: string | null = null;
  private pluginListeners: PluginListenerHandle[] = [];
  private mqttUnsubs: Array<() => void> = [];
  private stateListeners: Set<SendStateCallback> = new Set();

  /** 此平台是否支援原生螢幕發送(目前 iOS / Android) */
  isSupported(): boolean {
    try {
      const p = Capacitor.getPlatform();
      return p === 'ios' || p === 'android';
    } catch {
      return false;
    }
  }

  isSending(): boolean {
    return this.currentPeer !== null;
  }

  getCurrentPeer(): string | null {
    return this.currentPeer;
  }

  onStateChange(cb: SendStateCallback): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /**
   * 開始對指定 peer 投放本機螢幕。呼叫前 caller(App.tsx handleShareScreen)已過 Pro gate。
   * 注意:此 method 觸發原生擷取(iOS 會跳系統 broadcast picker),應由 user gesture 呼叫。
   */
  async start(peerPubkeyBase64: string): Promise<void> {
    if (!this.isSupported()) {
      throw new Error('Native screen send not supported on this platform');
    }
    if (this.currentPeer) {
      // 已在投放 → 先停掉舊的
      await this.stop();
    }
    this.currentPeer = peerPubkeyBase64;

    // 1) 原生 → JS：本機 offer / ICE / 狀態
    this.pluginListeners.push(
      await AegisScreenSend.addListener('screenSendLocalDescription', (e) => {
        if (!this.currentPeer) return;
        if (e.type !== 'offer') {
          // sender 端只應產生 offer(它是 offerer)
          diagLog('[DIAG:NativeSend] ignoring non-offer local description:', e.type);
          return;
        }
        mqttService.sendToUser(this.currentPeer, MessageType.SCREEN_SHARE_OFFER, {
          sdp: e.sdp,
          type: 'offer',
          transport: 'dedicated',
        });
        diagLog('[NSDIAG] got offer from native, sent SCREEN_SHARE_OFFER to', this.currentPeer.slice(0, 12), 'sdp', e.sdp.length, 'chars');
      }),
      await AegisScreenSend.addListener('screenSendIceCandidate', (e) => {
        if (!this.currentPeer) return;
        mqttService.sendToUser(this.currentPeer, MessageType.SCREEN_SHARE_ICE, {
          candidate: e.candidate,
          sdpMid: e.sdpMid,
          sdpMLineIndex: e.sdpMLineIndex,
        });
        diagLog('[NSDIAG] sent local ICE to', this.currentPeer.slice(0, 12));
      }),
      await AegisScreenSend.addListener('screenSendState', (e) => {
        diagLog('[NSDIAG] native state:', e.state, e.detail ?? '');
        this.notifyState(e.state);
        if (e.state === 'failed' || e.state === 'ended') {
          void this.stop();
        }
      }),
    );

    // 2) 接收端 → JS：answer / remote ICE（只收目標 peer 的 dedicated 信令）
    this.mqttUnsubs.push(
      mqttService.onMessage(MessageType.SCREEN_SHARE_ANSWER, (msg) => { void this.handleAnswer(msg); }),
      mqttService.onMessage(MessageType.SCREEN_SHARE_ICE, (msg) => { void this.handleRemoteIce(msg); }),
      mqttService.onMessage(MessageType.SCREEN_SHARE_REJECT, (msg) => this.handleReject(msg)),
      mqttService.onMessage(MessageType.SCREEN_SHARE_END, (msg) => this.handleEnd(msg)),
    );

    // 3) 啟動原生擷取 + 建 PC + 產生 offer
    try {
      diagLog('[NSDIAG] start() for', peerPubkeyBase64.slice(0, 12));
      await AegisScreenSend.startScreenSend({ peerPubkey: peerPubkeyBase64 });
      this.notifyState('starting');
      devLog('[NativeSend] startScreenSend invoked for', peerPubkeyBase64.slice(0, 16));
    } catch (err) {
      devWarn('[NativeSend] startScreenSend failed:', (err as Error).message);
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const peer = this.currentPeer;
    this.currentPeer = null;

    // 先通知接收端(信令早於 SRTP 斷線 → receiver UI 立刻收回 viewer)
    if (peer) {
      try {
        mqttService.sendToUser(peer, MessageType.SCREEN_SHARE_END, {});
      } catch (err) {
        devWarn('[NativeSend] send END failed:', (err as Error).message);
      }
    }

    try {
      await AegisScreenSend.stopScreenSend();
    } catch (err) {
      devWarn('[NativeSend] stopScreenSend failed:', (err as Error).message);
    }

    this.teardownListeners();
    this.notifyState('ended');
    if (peer) diagLog('[DIAG:NativeSend] stopped, peer:', peer.slice(0, 16));
  }

  // ============================================
  // Internal — MQTT inbound (from receiver)
  // ============================================

  private async handleAnswer(msg: MqttMessage): Promise<void> {
    if (!this.currentPeer || msg.from !== this.currentPeer) return;
    const payload = msg.payload as { sdp?: string; type?: string; transport?: string };
    if (!payload || payload.type !== 'answer' || !payload.sdp || payload.transport !== 'dedicated') return;
    try {
      await AegisScreenSend.setScreenSendRemoteDescription({ sdp: payload.sdp, type: 'answer' });
      diagLog('[NSDIAG] applied SCREEN_SHARE_ANSWER from', this.currentPeer.slice(0, 12));
    } catch (err) {
      devWarn('[NativeSend] setRemoteDescription failed:', (err as Error).message);
    }
  }

  private async handleRemoteIce(msg: MqttMessage): Promise<void> {
    if (!this.currentPeer || msg.from !== this.currentPeer) return;
    const init = msg.payload as { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
    if (!init || !init.candidate) return;
    try {
      await AegisScreenSend.addScreenSendIceCandidate({
        candidate: init.candidate,
        sdpMid: init.sdpMid ?? null,
        sdpMLineIndex: init.sdpMLineIndex ?? null,
      });
      diagLog('[NSDIAG] applied remote ICE from', this.currentPeer.slice(0, 12));
    } catch (err) {
      devWarn('[NativeSend] addIceCandidate failed:', (err as Error).message);
    }
  }

  private handleReject(msg: MqttMessage): void {
    if (!this.currentPeer || msg.from !== this.currentPeer) return;
    diagLog('[DIAG:NativeSend] peer rejected screen send:', this.currentPeer.slice(0, 16));
    void this.stop();
  }

  private handleEnd(msg: MqttMessage): void {
    if (!this.currentPeer || msg.from !== this.currentPeer) return;
    diagLog('[DIAG:NativeSend] peer ended screen send:', this.currentPeer.slice(0, 16));
    void this.stop();
  }

  // ============================================
  // Internal
  // ============================================

  private teardownListeners(): void {
    this.pluginListeners.forEach((h) => { try { void h.remove(); } catch { /* ignore */ } });
    this.pluginListeners = [];
    this.mqttUnsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
    this.mqttUnsubs = [];
  }

  private notifyState(state: string): void {
    this.stateListeners.forEach((cb) => {
      try { cb(state, this.currentPeer); } catch (err) { console.error('[NativeSend] state listener threw:', err); }
    });
  }
}

export const nativeScreenSenderService = new NativeScreenSenderService();
export default nativeScreenSenderService;
