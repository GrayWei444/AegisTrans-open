# Build Provenance — E2EE WASM core

Last verified: 2026-10-17

## Source

The Rust source of the encryption core now lives in this repository:
`packages/crypto-core/` (crate `safetalk-core` 0.1.0), together with
`Cargo.lock`, `rust-toolchain.toml` (rustc 1.90.0) and `build.sh`.
Build and verification steps: `packages/crypto-core/README.md`.

## Reproducible build (from this repository)

`packages/crypto-core/build.sh --verify` must produce exactly the hashes in
`packages/crypto-core/REPRODUCIBLE.sha256` and one of the two `.wasm` hashes in
`REPRODUCIBLE-wasm.sha256` (wasm-bindgen 0.2.106 orders two imports
nondeterministically; both variants are 305,025 bytes and otherwise identical):

| File | SHA-256 |
|---|---|
| `safetalk_core_bg.wasm` variant A | `28a9f0e0cec621a55fad6bbdb855ce6efdc8e404855bef1bba0bb791c3523b1a` |
| `safetalk_core_bg.wasm` variant B | `467927521fcead42114a1c899d6fed31cfc1121e7cd830988cbf1535f39a921e` |
| `safetalk_core.js` | `21f2ba1f54879bbb6dfe66dcf17cd9c941c8ba30bad5e92e205f15ecf2dd20d3` |
| `safetalk_core.d.ts` | `0b691f17f99fd09ad0ada9477756f7bd25a5a0d36358a316e12da358a9ccd027` |
| `safetalk_core_bg.wasm.d.ts` | `d86a383302d7769290e77f783966e2d314dd83b38ee4f68cea73519fffa4ba65` |
| `package.json` | `54eda0d7296f46b378a8161ef974e3c94dfd2a8e4e0ea56f3b00054a7450d0e3` |

Since 2026-10-18 the source contains **no logging of key material**: the
`console.log` calls in `ratchet.rs` / `x3dh.rs` that printed the first 8 bytes of
shared secrets, DH outputs, chain keys and public keys were removed (the exported
API and the `.d.ts` files are unchanged; the JS glue no longer imports
`console.log`).

## Binary that currently ships (`packages/pwa/src/wasm/pkg/`)

| File | Size | SHA-256 |
|---|---|---|
| `safetalk_core_bg.wasm` | 310,598 | `47f34a4d966c627a4c32c2baa1cb1aa5fdac11022a633a2095456268f1d71414` |
| `safetalk_core.js` | 53,921 | `85b8b9ba39239bfca30cda7701f93aa42774ec918294c675878ba663cad11361` |
| `safetalk_core.d.ts` | 15,389 | `0b691f17f99fd09ad0ada9477756f7bd25a5a0d36358a316e12da358a9ccd027` |

### Comparison (2026-10-17, made with the source as imported — before the logging removal)

- `safetalk_core.js`, `safetalk_core.d.ts`, `safetalk_core_bg.wasm.d.ts` and
  `package.json`: **byte-identical** to the reproducible build — same exported
  API and the same wasm-bindgen glue.
- `safetalk_core_bg.wasm`: **not identical**. What matches: producer section
  (rustc 1.90.0, wasm-bindgen 0.2.106, walrus 0.24.4), every dependency
  `name-version` embedded in panic paths (28 paths, e.g. `serde_json-1.0.145`,
  `curve25519-dalek-4.1.3`, `js-sys-0.3.83`), and every human-readable string
  (including the debug log strings of `ratchet.rs` / `x3dh.rs`).
  What differs: the shipped binary has 3 more functions, 7 more bytes of
  element table, 317 more bytes of code and 40 more bytes of data.
- Why it cannot be closed from here: the shipped binary was built on Windows
  (its panic paths start with a Windows user profile's `.cargo` directory) from
  the original `rust-core` repository, whose `Cargo.lock` and workspace layout
  are not available. Tried and ruled out: wasm-opt/binaryen versions 116–124
  (none changes the data or element sections), dependency snapshots from
  2025-11-28 to 2026-01-14, and path-length differences (remapped).
  Remaining candidates: different versions of dependencies that leave no path
  string (e.g. `x25519-dalek`, `aes-gcm`, `uuid`, `zeroize`), a different
  profile/workspace setting, or a small source difference.

### Production must be rebuilt from this source

The binary in `packages/pwa/src/wasm/pkg/` (and in the deployed apps) still
contains the key-material console logging that the source no longer has. It was
deliberately not replaced in this change. Rebuild it with
`packages/crypto-core/build.sh --verify --install`, test the apps, and ship that
build — then the published source and the shipped binary match (one of the two
listed `.wasm` variants).

## Rule

Any change to the shipped WASM MUST update this file and
`packages/crypto-core/REPRODUCIBLE.sha256` / `REPRODUCIBLE-wasm.sha256` in the same commit.
