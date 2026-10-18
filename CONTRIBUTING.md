# Contributing

Thanks for your interest. AegisTrans is MIT-licensed (see `LICENSE`); contributions
are accepted under the same license. Please open an issue to discuss a change
before sending a large pull request.

## Development setup

- Node.js 20+ and npm
- Rust via rustup, `wasm-pack` 0.13.1 and a C linker — only needed to build the
  encryption core (`packages/crypto-core/README.md`)
- Python 3.12 for the API (`api/requirements.txt`)

```bash
cd packages/aegis-display && npm install
cd ../pwa && npm ci
npm run dev            # builds the crypto core first if it is missing
npm run type-check && npm run lint && npm run build
```

API: see `api/README.md`; a full local stack is in `docs/SELF_HOSTING.md`.

## Checks

Run before opening a pull request:

```bash
for f in scripts/check-*.mjs; do node "$f" || exit 1; done
for f in scripts/check-*.py; do uv run --no-project --python 3.12 --with fastapi --with httpx --with pydantic python "$f" || exit 1; done
(cd api && python -m unittest test_schema_b test_google_iap test_iap_sandbox_allowlist)
```

The `.mjs` checks need `esbuild`, `mqtt`, `idb`, `hash-wasm` and `sql.js`
resolvable from `packages/pwa` (they are dependencies there after `npm ci`).

## Guidelines

- Keep changes small and focused; add or update a `scripts/check-*` script for
  behaviour changes.
- Never commit secrets, real e-mail addresses, server addresses of real
  deployments or build-machine details.
- New third-party code must use a permissive license that fits an MIT project
  (e.g. MIT, BSD, ISC, Apache-2.0) and be added to `THIRD_PARTY_NOTICES.md`.
- Commit messages: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci).
