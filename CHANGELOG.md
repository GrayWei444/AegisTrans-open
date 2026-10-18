# Changelog

## 1.0.6 — 2026-10-18

First public source release.

- Source published under the MIT license, with a standalone server (`api/app.py`) and a self-hosting guide.
- Settings → Server: use the official server (default) or your own.
- The encryption core is built from source with a pinned toolchain and no longer logs any key material.
- Removed a remote debug logger and leftover code from the app AegisTrans was forked from.
- Fixed: tapping a received photo opens it full screen again.
- The sign-in confirmation page, file buttons and image viewer follow the app language; the sign-in email is in Chinese and English.
- Self-hosted builds no longer label their own server "Official server".
