# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **"Report a
vulnerability"** button (Security → Advisories) on this repository. Do not open
public issues for security problems. Include steps to reproduce, affected
component and version/commit, and the impact you expect.

We aim to acknowledge reports within 7 days and to agree on a disclosure date
with you once a fix is available.

## Scope

In scope: the app (`packages/pwa`, including the Android/iOS/desktop shells),
the encryption core (`packages/crypto-core`), the API (`api/`) and the example
broker configuration (`docker-compose.example.yml`, `docs/SELF_HOSTING.md`).
Out of scope: third-party dependencies (report upstream), and deployments run
by other people.

## Design notes for reviewers

- Messages and files are end-to-end encrypted (X3DH + Double Ratchet, AES-256-GCM)
  and sent peer-to-peer over WebRTC. There is no TURN relay; STUN only.
- Servers see account e-mail addresses, the device list, IP addresses, MQTT
  topic activity (presence/timing) and encrypted signaling envelopes — not
  message content.
- MQTT access is limited per account by a JWT `acl` claim with default-deny on
  the broker (see `docs/SELF_HOSTING.md`).
- The app lets users choose their server at runtime, so the web build's
  Content-Security-Policy allows `connect-src https: wss:` (plus `localhost`
  for development).
- The crypto core does not log key material. Builds of this source can be
  checked against `packages/crypto-core/REPRODUCIBLE*.sha256`.

## Supported versions

Only the latest release receives security fixes.
