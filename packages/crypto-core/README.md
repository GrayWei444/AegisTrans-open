# crypto-core — AegisTrans end-to-end encryption core

Rust crate `safetalk-core` (X3DH, Double Ratchet, AES-256-GCM, Ed25519, HKDF),
compiled to WebAssembly with `wasm-bindgen`. The PWA imports the generated
module from `packages/pwa/src/wasm/pkg/safetalk_core.js`
(see `packages/pwa/src/services/crypto.ts`).

## Build

Requirements:

- `rustup` — `rust-toolchain.toml` pins rustc **1.90.0** and the
  `wasm32-unknown-unknown` target; rustup installs both on first use.
- `wasm-pack` **0.13.1** — `cargo install wasm-pack --version 0.13.1 --locked`.
  It downloads the matching `wasm-bindgen` CLI (0.2.106, from `Cargo.lock`)
  and binaryen `wasm-opt` version_117.
- A host C linker for build scripts / proc-macros
  (Linux: `build-essential`; macOS: Xcode Command Line Tools).

```bash
packages/crypto-core/build.sh            # build into packages/crypto-core/target/pkg
packages/crypto-core/build.sh --verify   # build and compare with REPRODUCIBLE.sha256
packages/crypto-core/build.sh --install  # build and copy into packages/pwa/src/wasm/pkg
```

`npm run build` in `packages/pwa` runs `scripts/ensure-crypto-wasm.mjs` first:
if `src/wasm/pkg/safetalk_core.js` is missing it calls `build.sh --install`.

## Reproducibility

`build.sh` passes `--locked` and remaps `$CARGO_HOME` and this directory to fixed
prefixes (`/cargo`, `/crypto-core`), because dependency source paths end up in
panic messages inside the `.wasm`. With the pinned toolchain, lockfile and
wasm-pack version the output does not depend on user name or checkout location.
`REPRODUCIBLE.sha256` lists the expected hashes of the JS glue, type definitions
and `package.json`. wasm-bindgen 0.2.106 emits two imports (`__wbindgen_cast_*`)
in a nondeterministic order, so the `.wasm` comes out as one of two byte-for-byte
variants of identical size; both are listed in `REPRODUCIBLE-wasm.sha256`
(observed over 15 builds on Linux, from different paths and `CARGO_HOME`s).

## Provenance

The source was imported from the AegisTalk repository's `packages/crypto-core`,
which in turn came from the original `rust-core` crate. That original
repository and its `Cargo.lock` are not available, so `Cargo.lock` here was
regenerated with every dependency pinned to the newest release published
before 2025-12-13 (wasm-bindgen family pinned to 0.2.106). See
`BUILD_PROVENANCE.md` at the repository root for how this compares with the
binary that currently ships.

## Tests

`cargo test --locked` runs the crate's unit tests on the host. 9 of 10 pass;
`aes::tests::test_aes_with_aad` fails on non-wasm targets only, because its
expected error path constructs a `JsError` (wasm-bindgen imports cannot be
called outside WebAssembly).

The crate does not log key material (removed 2026-10-18).
