import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crypto = readFileSync(resolve(root, 'packages/pwa/src/hooks/useCrypto.ts'), 'utf8');
const pairing = readFileSync(resolve(root, 'packages/pwa/src/services/devicePairing.ts'), 'utf8');
const webrtc = readFileSync(resolve(root, 'packages/pwa/src/services/webrtc.ts'), 'utf8');

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

check(crypto.includes('forceFresh?: boolean'), 'createSession must expose forceFresh');
check(crypto.includes('export function flushSessionWrites'), 'useCrypto must expose session write flush');
check(crypto.includes('existingForRecipient && !forceFresh'), 'createSession must keep normal idempotency');
check(crypto.includes('createSession forceFresh'), 'createSession must replace stale Alice on forceFresh');
check(crypto.includes('initiatedAtRef'), 'acceptSession must track initiator glare timing');
check(crypto.includes('forceReset?: boolean'), 'acceptSession must expose forceReset');
check(
  crypto.indexOf('lastEphemeralB64 === senderEphemeralB64') < crypto.indexOf('if (forceReset)'),
  'redelivered X3DH_INIT must skip before forceReset is considered'
);
check(crypto.includes('acceptSession GLARE'), 'acceptSession must keep glare tiebreak');
check(pairing.includes('payload.sessionReset === true'), 'devicePairing must pass sessionReset to acceptSession');
check(pairing.includes('forceReset = data.sessionReset === true'), 'devicePairing must map reset bundles to forceFresh');
check(pairing.includes('await crypto.flushSessionWrites?.();'), 'devicePairing must flush session writes before continuing');
check(!pairing.includes('Skipping PREKEY_REQUEST'), 'missing-session devices must be allowed to request pairing');
check(webrtc.includes('makingOffer.add') && webrtc.includes('makingOffer.delete'), 'WebRTC must track in-flight offers');
check(webrtc.includes('reopenDataChannelInPlace'), 'WebRTC must reopen DataChannel on the same PeerConnection');
check(webrtc.includes('PerfectNeg impolite IGNORING'), 'WebRTC must handle offer collision without closing the peer');
check(!webrtc.includes('if (!isInitiator) {\n      connection.ondatachannel'), 'WebRTC ondatachannel must be wired for initiators too');

console.log('communication invariants ok');
