# Self-hosting AegisTrans

AegisTrans apps connect to the official service by default. Anyone can run their
own server and point the app at it — either at runtime (Settings → Server, or
the "Server" line on the sign-in screen) or by building the app with a different
default server.

## What a server consists of

| Part | What it does | Sees message content? |
|---|---|---|
| API (`api/app.py`, FastAPI + SQLite) | E-mail sign-in, device list, MQTT tokens, subscription state | No |
| MQTT broker (EMQX 5) | Signaling between your own devices, presence, offline queue of encrypted envelopes | No — payloads are end-to-end encrypted |
| SMTP relay | Sends sign-in / password reset links | No |
| Static web host | Serves the PWA (`packages/pwa/dist`) | No |

Messages and files travel peer-to-peer (WebRTC) and are encrypted by the Rust/WASM
core (`packages/crypto-core`). There is no TURN relay by design; STUN is only used
for NAT discovery.

## Quick start (docker compose)

```bash
cp api/.env.example api/.env       # fill in the required values
echo "AEGIS_MQTT_JWT_SECRET=$(openssl rand -hex 32)" > .env
docker compose -f docker-compose.example.yml up -d
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/aegistrans/auth/server-config
```

Put a TLS reverse proxy in front (apps refuse plain `http`/`ws` except for
`localhost`):

```
api.example.com {
    reverse_proxy 127.0.0.1:8000
}
mqtt.example.com {
    reverse_proxy /mqtt 127.0.0.1:8083
}
trans.example.com {
    root * /srv/aegistrans/dist
    try_files {path} /index.html
    file_server
}
```

Without docker: `pip install -r api/requirements.txt`, export the variables from
`api/.env.example`, then `cd api && uvicorn app:create_app --factory --port 8000`.

## API settings

All settings are environment variables; `api/.env.example` lists every one with a
comment. Required: `AEGISTRANS_JWT_SECRET`, `AEGIS_MQTT_JWT_SECRET` (both ≥ 32
characters and different), `AEGIS_DB_PATH`, `AEGISTRANS_APP_URL`,
`AEGISTRANS_MAIL_FROM`, `AEGISTRANS_PUBLIC_MQTT_URL`. The API refuses to start
when one is missing.

CORS allows the origin of `AEGISTRANS_APP_URL` and the app shells
(`https://localhost` Android, `capacitor://localhost` iOS,
`capacitor-electron://-` desktop). Add other web origins whose users should be
able to choose your server with `AEGISTRANS_CORS_ORIGINS`.

## How the app finds the rest of your server

The user only enters the API URL. The app then calls

```
GET {api}/aegistrans/auth/server-config
```

which returns public connection details (no authentication, no secrets):

```json
{
  "service": "aegistrans",
  "api_version": 1,
  "mqtt_url": "wss://mqtt.example.com/mqtt",
  "turn_url": "turn:stun.example.com:3478",
  "stun_urls": ["stun:stun.example.com:3478"],
  "web_url": "https://trans.example.com",
  "name": "Example",
  "links": { "privacy": "https://…", "terms": "https://…", "support": "https://…" }
}
```

Only `service` and `mqtt_url` are required. The app accepts `https`/`wss` URLs only
(plain `http`/`ws` is allowed for `localhost` during development). The choice is
stored per installation. Switching servers disconnects, signs out and restarts the
app; signing in to an account on a different server afterwards deletes the previous
account's local messages and files on that device.

## MQTT broker: authentication and topic ACL

The API issues MQTT passwords as HS256 JWTs signed with `AEGIS_MQTT_JWT_SECRET`
(`POST /aegistrans/auth/mqtt/token`, valid 1 hour). The broker must:

1. Authenticate with JWT from the password field, same secret, reject expired tokens.
2. Take permissions from the token's `acl` claim and **deny everything else**
   (`no_match = deny`). `docker-compose.example.yml` shows the EMQX 5 settings.

A token is only issued for a device registered to the signed-in account, and its
`sub` is the hash of that device's registered public key. Its `acl` claim
(`{uid}` = account id):

| Permission | Topic filter | Purpose |
|---|---|---|
| publish + subscribe | `mist/acct/{uid}/#` | Inbox, presence and broadcasts of the account's own devices |
| publish + subscribe | `mist/group/aegistrans:{uid}:my-devices` | "My devices" group channel |
| subscribe only | `aegis/device/+/kicked` | Device revocation notice |
| subscribe only | `mist/broadcast` | Legacy global topic; old clients subscribe to it, nobody may publish |

Nothing grants access to another account's namespace, and no topic is publishable
across accounts. Keep `deny_action = ignore` so old clients that subscribe to the
legacy topic are not disconnected.

## Building apps that default to your server

```bash
(cd packages/aegis-display && npm install)   # local plugin the app imports; install it first
cd packages/pwa
cp .env.example .env.local     # set VITE_DEFAULT_API_URL, VITE_DEFAULT_MQTT_URL, …
npm ci && npm run build        # builds the crypto core first if needed (Rust required)
```

Setting `VITE_DEFAULT_API_URL` replaces all official defaults. For the web build,
`VITE_DEFAULT_WEB_API_PATH=/api` makes the app call the API through a same-origin
reverse proxy path instead of cross-origin.

## Limits that apply on any server

- Accounts get the device limits of their subscription tier as coded in
  `api/aegistrans_routes.py` (free: 2 devices, paid tiers: 10, absolute cap 16).
  In-app purchase verification is disabled until the `AEGISTRANS_IAP_*` /
  `AEGISTRANS_GOOGLE_*` settings are filled in. Tiers are stored in the
  `aegistrans_licenses` / entitlement tables of the SQLite database.
- No push notifications: apps receive messages while running.
