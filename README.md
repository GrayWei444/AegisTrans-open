# AegisTrans

End-to-end encrypted messages and files between your own devices — phone, tablet,
desktop and browser. Content travels peer-to-peer (WebRTC); servers only handle
sign-in, the device list and signaling.

> This repository is being prepared for open-source release. Documentation is
> still being written.

- **Self-hosting:** [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) — run your own
  server and switch the app to it in Settings → Server.
- **Encryption core:** [packages/crypto-core](packages/crypto-core/README.md)
  (Rust → WebAssembly, reproducible build).
- **Security reports:** [SECURITY.md](SECURITY.md) · **Contributing:**
  [CONTRIBUTING.md](CONTRIBUTING.md)

## Layout

| Path | What |
|---|---|
| `packages/pwa` | The app (React PWA; Android/iOS via Capacitor, desktop via Electron) |
| `packages/crypto-core` | X3DH + Double Ratchet core, compiled to WASM |
| `packages/aegis-display` | Screen-sharing / virtual display plugin |
| `api` | FastAPI server (`api/app.py` for self-hosting) |
| `scripts/check-*` | Regression checks (`node scripts/check-….mjs`, `python scripts/check-….py`) |

## License

MIT — see [LICENSE](LICENSE). Third-party
components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
