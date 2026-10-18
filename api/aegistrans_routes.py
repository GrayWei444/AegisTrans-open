"""
AegisTrans Auth + Subscription Router
=====================================
Email magic link 登入 + 訂閱狀態查詢。兩種跑法：
- 官方部署：掛在既有的 API process 裡（同 process / 同 SQLite），沿用下方「官方部署預設值」。
- 自架：api/app.py（AEGISTRANS_PROFILE=standalone），所有設定從環境變數來（api/.env.example）。
- POST /aegistrans/auth/email/request
- GET  /aegistrans/auth/email/verify
- GET  /aegistrans/auth/me
- GET  /aegistrans/subscription/status
- POST /aegistrans/subscription/dev-set-tier      (dev only — e2e/dogfood 用)
- POST /aegistrans/subscription/lemonsqueezy-webhook  (Phase 1B 填簽章驗證)

Tables 用 aegistrans_ prefix，與 AegisTalk tables 共存不衝突。
"""
import os
import sqlite3
import secrets
import hashlib
import hmac
import json
import time
import re
import smtplib
import base64
from datetime import datetime
from urllib.parse import quote
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid, parseaddr
from contextlib import contextmanager
from typing import Optional

from fastapi import APIRouter, HTTPException, Header, Request
from pydantic import BaseModel, Field


# ===== Config =====
# 官方部署的預設值：只在 router 掛在官方 API process 裡時用（AEGISTRANS_PROFILE 沒設或不是 standalone）。
# 自架的 api/app.py 會設 AEGISTRANS_PROFILE=standalone → 一律只讀環境變數，不會沿用官方的寄件人、網址或路徑。
# scripts/oss/export-public.sh 匯出公開版時會把 BEGIN／END 之間換成空字典。
_OFFICIAL_DEFAULTS = {}  # official deployment values are not part of the public source
PROFILE = os.environ.get("AEGISTRANS_PROFILE", "official")
_DEFAULTS = {} if PROFILE == "standalone" else _OFFICIAL_DEFAULTS


def _setting(name: str, default: str = "") -> str:
    """環境變數優先；沒設時用（官方部署才有的）預設值，再沒有就用 default。"""
    value = os.environ.get(name)
    if value is None:
        value = _DEFAULTS.get(name, default)
    return value


APP_BASE_URL = _setting("AEGISTRANS_APP_URL")
JWT_SECRET = os.environ.get("AEGISTRANS_JWT_SECRET", "")
MQTT_JWT_SECRET = os.environ.get("AEGIS_MQTT_JWT_SECRET", "")  # 與 EMQX broker 共享
MAGIC_TTL_SECONDS = 15 * 60          # 15 min
SESSION_TTL_SECONDS = 30 * 86400     # 30 days
MQTT_TOKEN_TTL_SECONDS = 60 * 60     # 1 hour（mqtt.ts 提前 5 分鐘刷新）
SMTP_HOST = _setting("AEGISTRANS_SMTP_HOST", "127.0.0.1")
SMTP_PORT = int(_setting("AEGISTRANS_SMTP_PORT", "25"))
SMTP_STARTTLS = _setting("AEGISTRANS_SMTP_STARTTLS", "0") == "1"
SMTP_USERNAME = _setting("AEGISTRANS_SMTP_USERNAME")
SMTP_PASSWORD = _setting("AEGISTRANS_SMTP_PASSWORD")
MAIL_FROM = _setting("AEGISTRANS_MAIL_FROM")
MAIL_REPLY_TO = _setting("AEGISTRANS_MAIL_REPLY_TO") or parseaddr(MAIL_FROM)[1]
MAIL_MSGID_DOMAIN = _setting("AEGISTRANS_MAIL_MSGID_DOMAIN") or (MAIL_REPLY_TO.rpartition("@")[2] or None)
MAIL_FOOTER_URL = _setting("AEGISTRANS_MAIL_FOOTER_URL") or APP_BASE_URL
DB_PATH = _setting("AEGIS_DB_PATH")

# 給用戶端「換伺服器」用的公開連線資訊（GET /aegistrans/auth/server-config）
PUBLIC_MQTT_URL = _setting("AEGISTRANS_PUBLIC_MQTT_URL")
PUBLIC_TURN_URL = _setting("AEGISTRANS_PUBLIC_TURN_URL")
PUBLIC_STUN_URLS = [u.strip() for u in _setting("AEGISTRANS_PUBLIC_STUN_URLS").split(",") if u.strip()]
SERVER_NAME = _setting("AEGISTRANS_SERVER_NAME")
PUBLIC_LINKS = {
    "privacy": _setting("AEGISTRANS_PRIVACY_URL"),
    "terms": _setting("AEGISTRANS_TERMS_URL"),
    "support": _setting("AEGISTRANS_SUPPORT_URL"),
}
# Dev mode：允許 /subscription/dev-set-tier 直接提權（給 e2e / dogfood 用）。
# Production 必須設成 "0"（預設 "0"）。
AEGISTRANS_DEV_MODE = os.environ.get("AEGISTRANS_DEV_MODE", "0") == "1"

# Tier 列舉（DB 用字串，避免 enum migrate 麻煩）
VALID_TIERS = {"free", "pro_monthly", "pro_yearly", "pro_lifetime"}
PRO_TIERS = {"pro_monthly", "pro_yearly", "pro_lifetime"}

# ===== IAP（StoreKit 2／Google Play 自家後端驗收據）=====
# 沒設定（自架預設）→ 購買驗證端點回 503，其他端點照常。
IAP_BUNDLE_ID = _setting("AEGISTRANS_IAP_BUNDLE_ID")
# App 的數字 Apple ID（ASC → App Information；production 驗章用）。
IAP_APP_APPLE_ID = int(_setting("AEGISTRANS_IAP_APP_APPLE_ID", "0") or "0")
# Apple Root CA（G3 等）DER 檔目錄；驗 StoreKit 簽名交易的憑證鏈根。需部署時放入。
IAP_APPLE_ROOT_DIR = _setting("AEGISTRANS_APPLE_ROOT_DIR")
_IAP_PRODUCT_PREFIX = _setting("AEGISTRANS_IAP_PRODUCT_PREFIX")
IAP_PRODUCT_TO_TIER = {
    f"{_IAP_PRODUCT_PREFIX}.monthly": "pro_monthly",
    f"{_IAP_PRODUCT_PREFIX}.yearly": "pro_yearly",
    f"{_IAP_PRODUCT_PREFIX}.lifetime": "pro_lifetime",
} if _IAP_PRODUCT_PREFIX else {}

# Google Play Billing。service-account JSON 只放伺服器，不進 repo。
GOOGLE_PLAY_PACKAGE = _setting("AEGISTRANS_GOOGLE_PLAY_PACKAGE")
GOOGLE_PLAY_SERVICE_ACCOUNT_FILE = _setting("AEGISTRANS_GOOGLE_SERVICE_ACCOUNT_FILE")
GOOGLE_PUBSUB_AUDIENCE = os.environ.get("AEGISTRANS_GOOGLE_PUBSUB_AUDIENCE", "")
GOOGLE_PUBSUB_SERVICE_ACCOUNT = os.environ.get("AEGISTRANS_GOOGLE_PUBSUB_SERVICE_ACCOUNT", "")
GOOGLE_PLAY_PRODUCT_TO_TIER = dict(IAP_PRODUCT_TO_TIER)
_google_play_session = None


def _expected_app_account_token(user_id: str) -> str:
    """CR-05：把 user_id 確定性映射成一個 UUID 字串，當 StoreKit appAccountToken。
    client(iap.ts)用同一公式算同一值帶進購買；後端重算比對 → 把交易綁到帳號。
    取 SHA-256(user_id) 前 16 bytes 格式化為標準 UUID（client 端 JS 同算法）。"""
    import uuid
    h = hashlib.sha256(user_id.encode("utf-8")).digest()[:16]
    return str(uuid.UUID(bytes=h))


def _get_google_play_session():
    """AuthorizedSession for Android Publisher API; lazy so missing credentials do not break auth APIs."""
    global _google_play_session
    if _google_play_session is not None:
        return _google_play_session
    if not GOOGLE_PLAY_PACKAGE or not GOOGLE_PLAY_SERVICE_ACCOUNT_FILE:
        raise RuntimeError("Google Play billing not configured on this server")
    if not os.path.isfile(GOOGLE_PLAY_SERVICE_ACCOUNT_FILE):
        raise RuntimeError(f"Google Play service account missing: {GOOGLE_PLAY_SERVICE_ACCOUNT_FILE}")
    from google.oauth2 import service_account
    from google.auth.transport.requests import AuthorizedSession
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_PLAY_SERVICE_ACCOUNT_FILE,
        scopes=["https://www.googleapis.com/auth/androidpublisher"],
    )
    _google_play_session = AuthorizedSession(creds)
    return _google_play_session


def _google_play_request(method: str, path: str):
    session = _get_google_play_session()
    url = "https://androidpublisher.googleapis.com/androidpublisher/v3" + path
    response = session.request(method, url, timeout=20)
    if response.status_code >= 400:
        # Do not echo a purchase token or service-account details to clients/logs.
        raise RuntimeError(f"Google Play API {method} failed ({response.status_code})")
    if not response.content:
        return {}
    return response.json()


def _rfc3339_unix(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def _pick_google_line_item(line_items, prefer_product_id=None):
    """從 subscriptionsv2 的 lineItems 選「權威」那一筆，回 (productId, expires_at)。
    review P2：deferred replacement（月轉年等）時 Google 同時回舊+新兩筆 line item，各有自己的
    expiryTime。**productId 與 expiryTime 必須成對取自同一筆**，不可「productId 取第一筆、expiry 取
    全部最大」——否則把舊 product 配上新 expiry，tier/到期日/重複訂閱判斷全錯。
      - verify（client 指定買了哪個 product）→ 取 productId 相符那筆。
      - RTDN（無指定）→ 取 expiry 最晚（= 目前生效）那筆。
    """
    parsed = [(x.get("productId"), _rfc3339_unix(x.get("expiryTime"))) for x in line_items]
    parsed = [(pid, exp) for pid, exp in parsed if pid]
    if not parsed:
        return None, None
    if prefer_product_id is not None:
        for pid, exp in parsed:
            if pid == prefer_product_id:
                return pid, exp
        return None, None  # 指定 product 不在回應內
    return max(parsed, key=lambda t: (t[1] is not None, t[1] or 0))

# 延遲建立 verifier（app-store-server-library 未裝 / 憑證未放時，API 仍能啟動；
# /verify 請求時才回 503，不影響其他端點）。快取避免每次請求重建。
_iap_verifiers = None  # tuple(sandbox, production) | None


def _load_apple_roots() -> list:
    import glob
    certs = []
    for path in sorted(glob.glob(os.path.join(IAP_APPLE_ROOT_DIR, "*.cer")) +
                       glob.glob(os.path.join(IAP_APPLE_ROOT_DIR, "*.der"))):
        with open(path, "rb") as f:
            certs.append(f.read())
    if not certs:
        raise RuntimeError(f"No Apple root certs in {IAP_APPLE_ROOT_DIR}")
    return certs


# H-1：sandbox 收據**預設不接受**。Apple 的 sandbox 環境任何人都能免費「購買」，若 production
# 接受 sandbox 簽章的交易 = 免費拿 Pro。只有 TestFlight / dogfood 環境才該開這個旗標。
IAP_ALLOW_SANDBOX = os.environ.get("IAP_ALLOW_SANDBOX", "") == "1"

# App 審核用：Apple 審核員的購買一律走 sandbox。上線後 IAP_ALLOW_SANDBOX 必須關掉，但若一併
# 關掉 sandbox 驗章，審核員按購買 → 收據被拒 → 以「IAP 無法完成」拒審。折衷：只有這份名單裡的
# user_id 接受 sandbox 收據（審核帳號 + dogfood 帳號），其他人一律只認 production。
IAP_SANDBOX_USER_IDS = frozenset(
    u.strip() for u in os.environ.get("IAP_SANDBOX_USER_IDS", "").split(",") if u.strip()
)

_iap_verifiers_sandbox = None  # 另一份快取：含 sandbox 的清單


def _get_iap_verifiers(allow_sandbox: bool = None):
    """回 [(env_name, verifier), ...]，依接受順序。未裝 lib / 無憑證 → raise（端點轉 503）。

    production 永遠優先且永遠接受。sandbox 是否加入清單：
    - allow_sandbox=None（預設）→ 看全域 IAP_ALLOW_SANDBOX
    - allow_sandbox=True/False  → 呼叫端逐請求決定（/verify 用 user_id 白名單）
    """
    global _iap_verifiers, _iap_verifiers_sandbox
    if allow_sandbox is None:
        allow_sandbox = IAP_ALLOW_SANDBOX
    cached = _iap_verifiers_sandbox if allow_sandbox else _iap_verifiers
    if cached is not None:
        return cached
    if not IAP_BUNDLE_ID or not IAP_APP_APPLE_ID or not IAP_APPLE_ROOT_DIR:
        raise RuntimeError("Apple in-app purchase not configured on this server")
    from appstoreserverlibrary.signed_data_verifier import SignedDataVerifier
    from appstoreserverlibrary.models.Environment import Environment
    roots = _load_apple_roots()
    production = SignedDataVerifier(roots, True, Environment.PRODUCTION, IAP_BUNDLE_ID, IAP_APP_APPLE_ID)
    verifiers = [("production", production)]
    if allow_sandbox:
        sandbox = SignedDataVerifier(roots, False, Environment.SANDBOX, IAP_BUNDLE_ID, IAP_APP_APPLE_ID)
        verifiers.append(("sandbox", sandbox))
        _iap_verifiers_sandbox = verifiers
    else:
        _iap_verifiers = verifiers
    return verifiers


# ===== DB =====
@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def create_aegistrans_tables():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_users (
                id           TEXT PRIMARY KEY,
                email        TEXT UNIQUE NOT NULL,
                created_at   INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_magic_tokens (
                token       TEXT PRIMARY KEY,
                email       TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                expires_at  INTEGER NOT NULL,
                used_at     INTEGER
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_aegistrans_mt_email ON aegistrans_magic_tokens(email)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_aegistrans_mt_exp   ON aegistrans_magic_tokens(expires_at)")
        # 自動「我的裝置群組」— 沒有獨立 group table，user_id 就是隱含群組 ID
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_devices (
                id            TEXT PRIMARY KEY,
                user_id       TEXT NOT NULL,
                label         TEXT NOT NULL,
                user_agent    TEXT,
                pubkey        TEXT,
                first_seen_at INTEGER NOT NULL,
                last_seen_at  INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES aegistrans_users(id)
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_aegistrans_dev_user ON aegistrans_devices(user_id)")
        # Phase C-1 migration：既有資料庫補上 pubkey 欄位（IF NOT EXISTS 不適用 ALTER，靠 try）
        try:
            conn.execute("ALTER TABLE aegistrans_devices ADD COLUMN pubkey TEXT")
        except sqlite3.OperationalError:
            pass  # column 已存在
        # Phase B (2026-05-06)：fingerprint_hash 欄位 — 同物理機在 pm clear / 重裝後仍能 dedupe
        try:
            conn.execute("ALTER TABLE aegistrans_devices ADD COLUMN fingerprint_hash TEXT")
        except sqlite3.OperationalError:
            pass  # column 已存在
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_aegistrans_dev_user_fp "
            "ON aegistrans_devices(user_id, fingerprint_hash)"
        )
        # CR-01 (2026-06-24)：可撤銷的 session（綁 user + device）。
        #   舊 JWT 只驗簽章+exp → 撤銷裝置/刪帳號後仍 30 天有效。改成 JWT 帶 sid,
        #   _require_user 查 session 是否 active + 綁定 device 是否還在。device_id 在
        #   register_device 才補綁（登入當下還沒註冊裝置）。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_sessions (
                sid          TEXT PRIMARY KEY,
                user_id      TEXT NOT NULL,
                device_id    TEXT,
                created_at   INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                expires_at   INTEGER NOT NULL,
                revoked_at   INTEGER
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_aegistrans_sess_user ON aegistrans_sessions(user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_aegistrans_sess_device ON aegistrans_sessions(device_id)")
        # Phase 1A.1：訂閱狀態（user_id 1:1，不存使用者實際資料/檔案 — 純 P2P 原則不破）
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_licenses (
                user_id      TEXT PRIMARY KEY,
                tier         TEXT NOT NULL,
                source       TEXT,
                expires_at   INTEGER,
                external_id  TEXT,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES aegistrans_users(id) ON DELETE CASCADE
            )
        """)
        # CR-05：同一筆外部交易(apple-<originalTxId>)不可被多帳號認領。partial unique index
        # （external_id 為 NULL 的 free row 不受限）。app 層也有顯式 owner 檢查，這是 DB 層防線。
        try:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_aegistrans_lic_external "
                "ON aegistrans_licenses(external_id) WHERE external_id IS NOT NULL"
            )
        except sqlite3.OperationalError:
            pass  # 既有重複 external_id（理論上不會，dev-/apple- 皆唯一）→ 不擋啟動
        # 亂序通知防呆 (review 2026-07-16)：記最後處理通知的 signedDate(ms)。晚到的舊事件
        # （尤其 EXPIRED/REFUND/REVOKE 降級）signedDate 較舊 → 忽略，避免把已續訂的有效授權打回 free。
        try:
            conn.execute("ALTER TABLE aegistrans_licenses ADD COLUMN last_event_ts INTEGER")
        except sqlite3.OperationalError:
            pass  # column 已存在
        # Schema B (2026-07-21)：兩層 entitlement。每筆商店購買一列（跨商店同帳號可並存），
        # aegistrans_licenses 降為「帳號目前最高有效 entitlement」的投影（_recompute_entitlement）。
        # 解掉單列 PK 的洞：同帳號 iPhone 月訂 + Android 賣斷 → 舊 schema 只留一筆、丟掉另一筆
        # token → RTDN 用被丟的 token 查無 license 直接忽略 → 月訂還在扣款但 app 顯示 Free。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_purchases (
                external_id   TEXT PRIMARY KEY,
                user_id       TEXT NOT NULL,
                store         TEXT NOT NULL,
                product_id    TEXT,
                tier          TEXT NOT NULL,
                state         TEXT NOT NULL,
                source        TEXT NOT NULL,
                store_token   TEXT,
                expires_at    INTEGER,
                last_event_ts INTEGER,
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES aegistrans_users(id) ON DELETE CASCADE
            )
        """)
        # external_id = 'apple-<originalTxId>' / 'google-<sha256(token)>' / 'dev-<user_id>'
        # store = 'apple'|'google'|'dev'；source 沿用舊值（含 _sandbox/_test 變體）
        # state = 'active'（有效、訂閱自動續訂中）|'cancelled'（自動續訂已關，付費期內仍有效）
        #         |'expired'|'refunded'
        # store_token = Google 原始 purchaseToken（伺服器端取消訂閱 API 需要；Apple 不存 —
        #   政策上 server 本來就不能取消 Apple 訂閱）
        conn.execute("CREATE INDEX IF NOT EXISTS idx_aegistrans_pur_user ON aegistrans_purchases(user_id)")
        # Migration：既有單列 licenses 搬進 purchases（冪等 — INSERT OR IGNORE，重啟不重複）。
        # tier='free' 的列（退款後殘留）無 entitlement 可保留，不搬。
        now_ts = int(time.time())
        conn.execute(
            """
            INSERT OR IGNORE INTO aegistrans_purchases
                (external_id, user_id, store, product_id, tier, state, source,
                 expires_at, last_event_ts, created_at, updated_at)
            SELECT CASE WHEN external_id LIKE 'dev-%' THEN 'dev-' || user_id ELSE external_id END,
                   user_id,
                   CASE WHEN source LIKE 'apple%' THEN 'apple'
                        WHEN source LIKE 'google%' THEN 'google'
                        ELSE 'dev' END,
                   NULL, tier,
                   CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'expired'
                        ELSE 'active' END,
                   COALESCE(source, 'dev'), expires_at, last_event_ts, created_at, updated_at
            FROM aegistrans_licenses
            WHERE external_id IS NOT NULL AND tier != 'free'
            """,
            (now_ts,),
        )
        # 保險：external_id NULL 的舊 pro 列（理論上只有極早期 dev 列）也搬，否則投影會把它刪成 free。
        conn.execute(
            """
            INSERT OR IGNORE INTO aegistrans_purchases
                (external_id, user_id, store, product_id, tier, state, source,
                 expires_at, last_event_ts, created_at, updated_at)
            SELECT 'legacy-' || user_id, user_id,
                   CASE WHEN source LIKE 'apple%' THEN 'apple'
                        WHEN source LIKE 'google%' THEN 'google'
                        ELSE 'dev' END,
                   NULL, tier,
                   CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'expired'
                        ELSE 'active' END,
                   COALESCE(source, 'dev'), expires_at, last_event_ts, created_at, updated_at
            FROM aegistrans_licenses
            WHERE external_id IS NULL AND tier != 'free'
            """,
            (now_ts,),
        )
        # Phase C-3 (2026-05-07)：login attempt log — rate-limit password_login 失敗
        # 記錄每次失敗（email + ip + ts），15 分鐘內 5 次以上同 (email, ip) 鎖 5 分鐘。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_login_attempts (
                email        TEXT NOT NULL,
                ip           TEXT NOT NULL,
                ts           INTEGER NOT NULL,
                success      INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_aegistrans_login_attempts_lookup "
            "ON aegistrans_login_attempts(email, ip, ts)"
        )
        # 刪除帳號的墓碑（只有隨機帳號 id＋時間）：_require_user 只對真的刪過的帳號回「Account no longer exists」
        # （用戶端會登出）；帳號不見又沒有墓碑＝API 連到錯的／空的資料庫 → 503（AegisTrans 審查 F，對應 TofuTalk 50efc62）。
        # 超過 session 壽命就清掉：那時這個帳號的 JWT 都已過期。aegistrans 自己的表（SQLite 檔跟 AegisTalk 共用）。
        conn.execute("""
            CREATE TABLE IF NOT EXISTS aegistrans_deleted_users (
                id          TEXT PRIMARY KEY,
                deleted_at  INTEGER NOT NULL
            )
        """)


# ===== Email helpers =====
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def normalize_email(email: str) -> str:
    email = email.strip().lower()
    if email.endswith("@gmail.com") or email.endswith("@googlemail.com"):
        local, _, domain = email.partition("@")
        local = local.split("+", 1)[0].replace(".", "")
        email = f"{local}@{domain}"
    return email


def is_valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match(email)) and len(email) <= 254


def gen_token() -> str:
    return secrets.token_hex(32)


# ===== JWT (HS256, dependency-free) =====
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = -len(s) % 4
    return base64.urlsafe_b64decode(s + "=" * pad)


def sign_jwt(payload: dict) -> str:
    if not JWT_SECRET:
        raise RuntimeError("AEGISTRANS_JWT_SECRET not configured")
    h = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(JWT_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url(sig)}"


# ===== Password hashing (scrypt, stdlib) =====
def hash_password(password: str) -> str:
    """scrypt$<salt_hex>$<hash_hex>"""
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${h.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if not stored or not password:
        return False
    parts = stored.split("$")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    try:
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def sign_mqtt_jwt(pubkey_hash: str, acl: Optional[dict] = None) -> tuple[str, int]:
    """簽 MQTT JWT（給 EMQX broker 驗）。回傳 (token, expires_at_unix_seconds)。

    acl（EMQX `acl_claim_name=acl`,object 格式 {pub,sub,all}）:傳入則把該 client 的
    MQTT 授權限縮到自己帳號的 topic。C-1 修正:配合 broker `no_match=deny` 才真正 default-deny;
    在 no_match 仍為 allow 的過渡期,帶 acl 也不會鎖死任何人(只是額外 allow)。
    """
    if not MQTT_JWT_SECRET:
        raise RuntimeError("AEGIS_MQTT_JWT_SECRET not configured")
    now = int(time.time())
    exp = now + MQTT_TOKEN_TTL_SECONDS
    payload = {
        "sub": pubkey_hash,
        "exp": exp,
        "iat": now,
        "iss": "aegisrd",
    }
    if acl is not None:
        payload["acl"] = acl
    h = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    p = _b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(MQTT_JWT_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}.{_b64url(sig)}", exp


def pubkey_hash(pubkey_b64: str) -> str:
    """重算 client 的 pubkeyHash，必須與 mqtt.ts 完全一致：
        toUrlSafeBase64(b64) = b64.replace(+→-, /→_, =→'')
        pubkeyHash = sha256_hex(utf8(toUrlSafeBase64(pubkey)))[:32]
    關鍵：client hash 的是「URL-safe base64 字串本身」（不是 decode 後的 bytes）。
    早期版本誤拿 decode bytes 比對才對不上，導致直接放棄綁定（留下跨用戶授權洞）。
    """
    safe = pubkey_b64.replace("+", "-").replace("/", "_").replace("=", "")
    return hashlib.sha256(safe.encode("utf-8")).hexdigest()[:32]


def verify_jwt(token: str) -> Optional[dict]:
    if not token or not JWT_SECRET:
        return None
    try:
        h, p, s = token.split(".")
        expected = hmac.new(JWT_SECRET.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(_b64url_decode(s), expected):
            return None
        payload = json.loads(_b64url_decode(p))
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None


# ===== Send magic link email =====
def _html_escape(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def _url_host(url: str) -> str:
    """頁尾顯示用：https://example.com/x → example.com"""
    rest = url.split("://", 1)[-1]
    host = rest.split("/", 1)[0]
    return host[4:] if host.startswith("www.") else host


def send_magic_link_email(to: str, magic_url: str) -> bool:
    html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 16px">
 <tr><td align="center">
  <table width="480" cellpadding="0" cellspacing="0" style="background:#0d1b2a;border-radius:12px;color:#e0e0e0;padding:32px 28px">
   <tr><td>
    <h1 style="color:#26c6da;margin:0 0 16px;font-size:24px">AegisTrans</h1>
    <p style="margin:0 0 24px;color:#bbb;font-size:14px;line-height:1.6">
     有人（可能是你）正在使用此 email 登入 AegisTrans。<br>
     點擊下方按鈕完成 email 驗證：
    </p>
    <p style="margin:0 0 24px;text-align:center">
     <a href="{magic_url}" style="display:inline-block;background:#26c6da;color:#0d1b2a;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px">完成驗證</a>
    </p>
    <p style="margin:0;color:#888;font-size:12px;line-height:1.5">
     按鈕無法點擊？複製這個連結：<br>
     <span style="color:#26c6da;word-break:break-all">{magic_url}</span>
    </p>
    <p style="margin:20px 0 0;color:#bbb;font-size:13px;line-height:1.6;background:rgba(38,198,218,0.08);padding:12px;border-radius:6px;border-left:3px solid #26c6da">
     ✓ 驗證完成後，請回到剛才開始登入的地方，<br>
     系統會自動完成登入。
    </p>
    <p style="margin:20px 0 0;color:#666;font-size:12px;border-top:1px solid rgba(255,255,255,.1);padding-top:16px">
     連結 15 分鐘內有效。<br>
     如果不是你申請的，請忽略此信，不會發生任何事。
    </p>
   </td></tr>
  </table>
  <p style="color:#888;font-size:11px;margin-top:16px">
   AegisTrans · <a href="{_html_escape(MAIL_FOOTER_URL)}" style="color:#888">{_html_escape(_url_host(MAIL_FOOTER_URL))}</a>
  </p>
 </td></tr>
</table>
</body></html>"""

    msg = MIMEText(html, "html", "utf-8")
    msg["From"] = MAIL_FROM
    msg["To"] = to
    msg["Subject"] = "AegisTrans Email 驗證連結"
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=MAIL_MSGID_DOMAIN)
    if MAIL_REPLY_TO:
        msg["Reply-To"] = MAIL_REPLY_TO

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
            if SMTP_STARTTLS:
                s.starttls()
            if SMTP_USERNAME:
                s.login(SMTP_USERNAME, SMTP_PASSWORD)
            s.send_message(msg)
        return True
    except Exception as e:
        # 不印完整收件 email（PII，且 log 與 AegisTalk 共用 process）；只留 domain 供除錯。
        _dom = to.split("@", 1)[-1] if "@" in to else "unknown"
        print(f"[aegistrans-mail] send failed (domain={_dom}): {e}", flush=True)
        return False


# ===== Schemas =====
class RequestLinkBody(BaseModel):
    email: str = Field(..., max_length=254)
    request_id: str = Field(..., min_length=24, max_length=128)  # client-generated nonce（client 送 32-hex randomUUID；floor 24 防弱 nonce 爆破 verified token）
    # C-3：device label（讓 victim 在 verify 頁能看到「誰在請求登入」，可拒絕陌生裝置）
    client_label: Optional[str] = Field(None, max_length=120)


class RequestLinkResponse(BaseModel):
    ok: bool


class VerifyTokenBody(BaseModel):
    token: str = Field(..., max_length=128)
    # C-3：second-step explicit confirmation（避免 silent CSRF — 任何人造訪 URL 即標 verified）
    # confirmed=False → 只回傳 client_label 給 UI 顯示，不寫 verified_at
    # confirmed=True  → 真正寫 verified_at（user 看完 device_label 後按確認）
    confirmed: bool = False


class VerifyTokenResponse(BaseModel):
    ok: bool
    error: Optional[str] = None
    email: Optional[str] = None
    client_label: Optional[str] = None
    confirmed: bool = False


class PollBody(BaseModel):
    request_id: str = Field(..., min_length=24, max_length=128)  # 同 RequestLinkBody：32-hex nonce，floor 24


class PollResponse(BaseModel):
    status: str  # 'pending' | 'verified' | 'expired' | 'not_found' | 'consumed'
    token: Optional[str] = None
    user: Optional[dict] = None


class VerifyResponse(BaseModel):
    ok: bool
    token: Optional[str] = None
    user: Optional[dict] = None
    error: Optional[str] = None


class MeResponse(BaseModel):
    user: dict


class DeviceRegisterBody(BaseModel):
    label: str = Field(..., max_length=80)
    user_agent: Optional[str] = Field(None, max_length=400)
    pubkey: Optional[str] = Field(None, max_length=128)  # Ed25519 公鑰 base64
    fingerprint_hash: Optional[str] = Field(None, max_length=128)  # SHA-256 hex of stable hardware features


class DevicePubkeyBody(BaseModel):
    pubkey: str = Field(..., max_length=128)


class MqttTokenRequest(BaseModel):
    pubkeyHash: str = Field(..., min_length=8, max_length=64)
    # C-3：MQTT token 綁裝置 — 必須對應 (user_id, device_id, pubkey) 三元組存在且未撤銷
    device_id: Optional[str] = Field(None, max_length=64)


class MqttTokenResponse(BaseModel):
    token: str
    expiresAt: int


class PasswordLoginBody(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=8, max_length=200)


class PasswordSetBody(BaseModel):
    password: str = Field(..., min_length=8, max_length=200)
    # C-3：改密碼 step-up — 已設過密碼者必須提供 current_password 才能改
    # 首次設定（password_hash IS NULL）可不帶
    current_password: Optional[str] = Field(None, min_length=8, max_length=200)


class DeviceInfo(BaseModel):
    id: str
    label: str
    user_agent: Optional[str] = None
    pubkey: Optional[str] = None
    first_seen_at: int
    last_seen_at: int


class DeviceListResponse(BaseModel):
    devices: list[DeviceInfo]


# ===== Subscription schemas (Phase 1A.1) =====
class RedundantSubscription(BaseModel):
    """Schema B：比目前 entitlement 低階、卻仍在自動扣款的訂閱（跨商店升級後的重疊期）。
    client 據此顯示「請取消舊訂閱」持續提醒；Google 端 server 會先嘗試自動取消，
    Apple 端只能等使用者手動取消（webhook 收到 cancel 事件後這裡就消失）。"""
    store: str                         # 'apple' | 'google'
    product_id: Optional[str] = None
    tier: str
    expires_at: Optional[int] = None


class SubscriptionStatusResponse(BaseModel):
    tier: str                          # 'free' | 'pro_monthly' | 'pro_yearly' | 'pro_lifetime'
    is_pro: bool
    source: Optional[str] = None       # 'lemonsqueezy' | 'apple' | 'google' | 'dev' | None
    expires_at: Optional[int] = None   # unix sec; None → free or lifetime
    redundant_subscriptions: list[RedundantSubscription] = []


class DevSetTierBody(BaseModel):
    tier: str = Field(..., max_length=32)
    expires_in_seconds: Optional[int] = None  # None → 無到期（lifetime / free）


class VerifyPurchaseBody(BaseModel):
    # StoreKit 2 的 Transaction.jwsRepresentation（簽名交易）
    signedTransaction: str = Field(..., min_length=20, max_length=8192)


class VerifyGooglePurchaseBody(BaseModel):
    productId: str = Field(..., min_length=8, max_length=160)
    purchaseToken: str = Field(..., min_length=20, max_length=4096)
    productType: str = Field(..., pattern="^(subs|inapp)$")


# ===== Auth helper =====
def _create_session(conn, user_id: str, now: int) -> str:
    """CR-01：建立一筆可撤銷的 session，回傳 sid（放進 JWT）。device_id 在 register_device 補綁。"""
    sid = secrets.token_hex(16)
    conn.execute(
        "INSERT INTO aegistrans_sessions (sid, user_id, device_id, created_at, last_seen_at, expires_at) "
        "VALUES (?,?,NULL,?,?,?)",
        (sid, user_id, now, now, now + SESSION_TTL_SECONDS),
    )
    return sid


def _link_session_to_device(payload: dict, device_id: str) -> None:
    """CR-01：register_device 時把當前 session 綁到該 device → 撤銷 device 時可連帶撤銷 session。"""
    sid = payload.get("sid")
    if not sid:
        return  # legacy JWT（無 sid）— grandfather，不綁
    with get_db() as conn:
        conn.execute(
            "UPDATE aegistrans_sessions SET device_id=? WHERE sid=? AND revoked_at IS NULL",
            (device_id, sid),
        )


def _require_user(authorization: Optional[str]) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing token")
    payload = verify_jwt(authorization[7:])
    if not payload:
        raise HTTPException(401, "Invalid or expired token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(401, "Invalid token")
    now = int(time.time())
    with get_db() as conn:
        # CR-01：帳號刪除後 JWT 立即失效（含 legacy 無 sid 的 token，不靠 30 天 exp）。
        if not conn.execute("SELECT 1 FROM aegistrans_users WHERE id=?", (user_id,)).fetchone():
            # 只有刪帳號端點留下墓碑的帳號才回撤銷答案（用戶端登出）。找不到又沒有墓碑：多半是共用的 API 行程連到錯的／
            # 空的資料庫，以前所有開著的 App 一起被登出（AegisTrans 審查 F）→ 503，用戶端當成暫時性錯誤保留登入、稍後重試。
            if conn.execute("SELECT 1 FROM aegistrans_deleted_users WHERE id=?", (user_id,)).fetchone():
                raise HTTPException(401, "Account no longer exists")
            raise HTTPException(503, "Account store unavailable")
        sid = payload.get("sid")
        # 商用化收尾：無 sid 的 legacy JWT 一律拒收（原本 grandfather，但那種 token 無法被
        # 裝置/session 撤銷，被竊即可用到 30 天 exp）。CR-01(2026-06-24) 後所有簽發都帶 sid，
        # 故拒收只影響「2026-06-24 前發、且至今沒重登」的舊 token → client 收 401 自動登出、
        # 重登即取得可撤銷 session。
        if not sid:
            raise HTTPException(401, "Legacy session; please sign in again")
        # 新版 session：可被撤銷 + 綁裝置。
        sess = conn.execute(
            "SELECT device_id, revoked_at, expires_at FROM aegistrans_sessions WHERE sid=? AND user_id=?",
            (sid, user_id),
        ).fetchone()
        if not sess or sess["revoked_at"] is not None or sess["expires_at"] < now:
            raise HTTPException(401, "Session revoked or expired")
        # 綁定的裝置若已被撤銷（device row 不在）→ session 失效。
        if sess["device_id"] and not conn.execute(
            "SELECT 1 FROM aegistrans_devices WHERE id=? AND user_id=?",
            (sess["device_id"], user_id),
        ).fetchone():
            raise HTTPException(401, "Device revoked")
        # 不在這裡寫 last_seen：_require_user 每個 request 都跑,保持唯讀避免與
        # 共置的 AegisTalk 在共用 SQLite 上搶寫鎖（device ping 端另有 last_seen 更新）。
        # 綁定的裝置一併帶出，只能「動自己這台」的端點用（稽核 B20）
        payload = {**payload, "_device_id": sess["device_id"]}
    return payload


def _client_ip(request: Request) -> str:
    """取 client IP — Caddy 走 X-Forwarded-For；fallback 用直連 host。
    截到單一 IP（最左邊）+ truncate 防超長 attacker spoof。"""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown")[:64]


# ===== Login attempt rate limit (C-3) =====
LOGIN_ATTEMPT_WINDOW = 15 * 60      # 15 分鐘觀察窗
LOGIN_ATTEMPT_LIMIT = 5             # 5 次失敗
LOGIN_ATTEMPT_LOCKOUT = 5 * 60      # 鎖 5 分鐘


def _is_login_locked(email: str, ip: str) -> bool:
    """檢查 (email, ip) 是否在 LOCKOUT 期間內。
    條件：過去 LOCKOUT 秒內失敗 >= LIMIT 次，且最後一次失敗距現在 < LOCKOUT。"""
    now = int(time.time())
    with get_db() as conn:
        # 計算過去 WINDOW 內的失敗次數
        recent_failures = conn.execute(
            "SELECT COUNT(*) c, MAX(ts) last_ts FROM aegistrans_login_attempts "
            "WHERE email=? AND ip=? AND success=0 AND ts > ?",
            (email, ip, now - LOGIN_ATTEMPT_WINDOW)
        ).fetchone()
    if not recent_failures or recent_failures["c"] < LOGIN_ATTEMPT_LIMIT:
        return False
    last_ts = recent_failures["last_ts"]
    if last_ts is None:
        return False
    # 最後一次失敗在 lockout 窗內 → 仍鎖
    return (now - last_ts) < LOGIN_ATTEMPT_LOCKOUT


def _record_login_attempt(email: str, ip: str, success: bool) -> None:
    now = int(time.time())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO aegistrans_login_attempts (email, ip, ts, success) VALUES (?,?,?,?)",
            (email, ip, now, 1 if success else 0)
        )
        # 順便清掉 24h 前的舊紀錄（成本低）
        conn.execute(
            "DELETE FROM aegistrans_login_attempts WHERE ts < ?",
            (now - 86400,)
        )


# ===== Magic-link per-IP rate limit（防 mailbomb / 損傷寄信信譽）=====
# per-email 已有 60s 限制（request_link 內），但缺 per-IP → 可輪換 email 對任意第三方
# 信箱發垃圾信。借用 aegistrans_login_attempts 表 + 一個保留 email key 計數，與真實登入
# lockout（查特定 email + success=0）完全隔離；24h 清理沿用 _record_login_attempt。
MAGLINK_IP_WINDOW = 3600       # 1 小時觀察窗
MAGLINK_IP_LIMIT = 20          # 每 IP 每小時最多 20 封 magic-link
_MAGLINK_IP_MARKER = "__maglink_ip__"


def _maglink_ip_throttled(ip: str) -> bool:
    now = int(time.time())
    with get_db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) c FROM aegistrans_login_attempts "
            "WHERE email=? AND ip=? AND ts > ?",
            (_MAGLINK_IP_MARKER, ip, now - MAGLINK_IP_WINDOW)
        ).fetchone()
    return bool(row and row["c"] >= MAGLINK_IP_LIMIT)


def _record_maglink_send(ip: str) -> None:
    now = int(time.time())
    with get_db() as conn:
        conn.execute(
            "INSERT INTO aegistrans_login_attempts (email, ip, ts, success) VALUES (?,?,?,?)",
            (_MAGLINK_IP_MARKER, ip, now, 1)
        )


# ===== Router =====
def create_aegistrans_router() -> APIRouter:
    create_aegistrans_tables()
    # Phase C-2 migration：aegistrans_users 加 password_hash 欄位
    with get_db() as conn:
        try:
            conn.execute("ALTER TABLE aegistrans_users ADD COLUMN password_hash TEXT")
        except sqlite3.OperationalError:
            pass  # 已存在
        # email_display：使用者寫的原始 email(可能含 Gmail dots)。lookup/JWT 仍用正規化的
        # email 欄(strip dots)做比對;這欄只給 UI 顯示「使用者自己寫的樣子」。NULL → fallback email。
        try:
            conn.execute("ALTER TABLE aegistrans_users ADD COLUMN email_display TEXT")
        except sqlite3.OperationalError:
            pass  # 已存在
        # Phase C-2 polling: aegistrans_magic_tokens 加 request_id + verified_at
        try:
            conn.execute("ALTER TABLE aegistrans_magic_tokens ADD COLUMN request_id TEXT")
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute("ALTER TABLE aegistrans_magic_tokens ADD COLUMN verified_at INTEGER")
        except sqlite3.OperationalError:
            pass
        # Phase C-3 (2026-05-07)：client_label — 讓 verify 頁顯示「誰請求登入」防 CSRF
        try:
            conn.execute("ALTER TABLE aegistrans_magic_tokens ADD COLUMN client_label TEXT")
        except sqlite3.OperationalError:
            pass
        conn.execute("CREATE INDEX IF NOT EXISTS idx_aegistrans_mt_req ON aegistrans_magic_tokens(request_id)")
        # Phase C-2 一次性清理：刪除同 (user_id, pubkey) 的重複 device row（保留最舊）
        conn.execute("""
            DELETE FROM aegistrans_devices
            WHERE rowid NOT IN (
                SELECT MIN(rowid) FROM aegistrans_devices
                WHERE pubkey IS NOT NULL AND pubkey != ''
                GROUP BY user_id, pubkey
            )
            AND pubkey IS NOT NULL AND pubkey != ''
        """)
    r = APIRouter(prefix="/aegistrans/auth", tags=["aegistrans-auth"])

    @r.get("/server-config")
    def server_config():
        """用戶端「換伺服器」時讀的公開連線資訊（不需登入、不含任何密鑰）。
        mqtt_url 沒設 → 503：用戶端會說「設定不完整」，不會切過來。"""
        if not PUBLIC_MQTT_URL:
            raise HTTPException(503, "Server not configured: AEGISTRANS_PUBLIC_MQTT_URL is empty")
        body = {"service": "aegistrans", "api_version": 1, "mqtt_url": PUBLIC_MQTT_URL}
        if PUBLIC_TURN_URL:
            body["turn_url"] = PUBLIC_TURN_URL
        if PUBLIC_STUN_URLS:
            body["stun_urls"] = PUBLIC_STUN_URLS
        if APP_BASE_URL:
            body["web_url"] = APP_BASE_URL
        if SERVER_NAME:
            body["name"] = SERVER_NAME
        links = {k: v for k, v in PUBLIC_LINKS.items() if v}
        if links:
            body["links"] = links
        return body

    @r.post("/email/request", response_model=RequestLinkResponse)
    async def request_link(body: RequestLinkBody, request: Request):
        email = normalize_email(body.email)
        if not is_valid_email(email):
            raise HTTPException(400, "Invalid email format")

        ip = _client_ip(request)
        if _maglink_ip_throttled(ip):
            # per-IP 節流（mailbomb 防護）。IP-based、非 email-specific → 回 429 不洩漏帳號存在性。
            raise HTTPException(429, "Too many magic-link requests; please try again later")

        now = int(time.time())
        # rate-limit: 1 token / 60s per email
        with get_db() as conn:
            recent = conn.execute(
                "SELECT token, created_at, verified_at FROM aegistrans_magic_tokens WHERE email=? ORDER BY created_at DESC LIMIT 1",
                (email,)
            ).fetchone()
            if recent and (now - recent["created_at"]) < 60:
                # 60s 內重複請求:不寄新信(防 spam)、對外仍回 ok(避免 email enumeration)。
                # CR-03 (2026-06-24):**不再 rebind** token 的 request_id。
                #   舊行為把未驗證 token 的 request_id 改綁到「後到的請求」→ 攻擊者在 60s 內用
                #   自己的 request_id 請求 victim 的 email,就能接管 victim 自己發起的登入:victim
                #   點信確認後,攻擊者用自己的 request_id poll 即拿到 victim 的 JWT。
                #   legit client 已改為「同 email 重送沿用原 request_id」(auth.ts requestLoginLink),
                #   因此 server 無需 rebind 即可支援重送;不可信的後到 request_id 一律不綁。
                return RequestLinkResponse(ok=True)

            token = gen_token()
            conn.execute(
                "INSERT INTO aegistrans_magic_tokens (token, email, request_id, client_label, created_at, expires_at) "
                "VALUES (?,?,?,?,?,?)",
                (token, email, body.request_id, (body.client_label or "")[:120], now, now + MAGIC_TTL_SECONDS)
            )

        magic_url = f"{APP_BASE_URL}/auth/verify?token={token}"
        if not send_magic_link_email(email, magic_url):
            with get_db() as conn:
                conn.execute("DELETE FROM aegistrans_magic_tokens WHERE token=?", (token,))
            raise HTTPException(500, "Failed to send email")

        _record_maglink_send(ip)  # 只在真的寄出時計入 per-IP 額度
        return RequestLinkResponse(ok=True)

    @r.post("/email/verify", response_model=VerifyTokenResponse)
    async def verify_link_mark(body: VerifyTokenBody):
        """C-3：兩階段確認（防 CSRF / login takeover）。

        Step 1：confirmed=False → 只回傳 token 對應的 email + client_label，**不寫 verified_at**。
                  Frontend 用這個 response 在 verify 頁面顯示「[client_label] 正在請求登入，確認嗎？」
        Step 2：confirmed=True → 用戶按下「確認」按鈕後再呼叫，這次才標 verified_at。
                  之後 /email/poll 才會發 JWT 給原裝置。

        舊行為（任何人造訪 URL 即 silently 標 verified）= attacker 持有 request_id 就能取得 victim
        帳號 JWT。新行為要求「點擊裝置」上的人類用戶看到 client_label 後主動確認，否則 token 不可用。
        """
        token = body.token
        now = int(time.time())
        with get_db() as conn:
            row = conn.execute(
                "SELECT email, expires_at, used_at, verified_at, client_label FROM aegistrans_magic_tokens WHERE token=?",
                (token,)
            ).fetchone()
            if not row:
                return VerifyTokenResponse(ok=False, error="連結無效")
            if row["used_at"]:
                return VerifyTokenResponse(ok=False, error="連結已使用")
            if row["expires_at"] < now:
                return VerifyTokenResponse(ok=False, error="連結已過期")

            already_verified = bool(row["verified_at"])
            if body.confirmed and not already_verified:
                conn.execute("UPDATE aegistrans_magic_tokens SET verified_at=? WHERE token=?", (now, token))
                already_verified = True

        return VerifyTokenResponse(
            ok=True,
            email=row["email"],
            client_label=row["client_label"] or None,
            confirmed=already_verified,
        )

    @r.post("/email/poll", response_model=PollResponse)
    async def email_poll(body: PollBody):
        """原裝置輪詢：若該 request_id 對應的 token 已 verified 但尚未 used → 簽 JWT 並標 used。"""
        now = int(time.time())
        with get_db() as conn:
            row = conn.execute(
                "SELECT token, email, expires_at, verified_at, used_at FROM aegistrans_magic_tokens "
                "WHERE request_id=? ORDER BY created_at DESC LIMIT 1",
                (body.request_id,)
            ).fetchone()

            if not row:
                return PollResponse(status="not_found")
            if row["used_at"]:
                return PollResponse(status="consumed")
            if row["expires_at"] < now:
                return PollResponse(status="expired")
            if not row["verified_at"]:
                return PollResponse(status="pending")

            # 已 verified 且 not used → 標 used + 簽 JWT
            conn.execute("UPDATE aegistrans_magic_tokens SET used_at=? WHERE token=?", (now, row["token"]))

            user = conn.execute("SELECT * FROM aegistrans_users WHERE email=?", (row["email"],)).fetchone()
            if user:
                user_id = user["id"]
                conn.execute("UPDATE aegistrans_users SET last_seen_at=? WHERE id=?", (now, user_id))
            else:
                user_id = secrets.token_hex(16)
                conn.execute(
                    "INSERT INTO aegistrans_users (id, email, created_at, last_seen_at) VALUES (?,?,?,?)",
                    (user_id, row["email"], now, now)
                )
            sid = _create_session(conn, user_id, now)  # CR-01：可撤銷 session

        jwt = sign_jwt({
            "sub": user_id,
            "email": row["email"],
            "sid": sid,
            "iat": now,
            "exp": now + SESSION_TTL_SECONDS,
        })
        # 顯示用 email：existing user 有設 email_display 就用它(原樣),否則 fallback 正規化 email。
        display_email = user["email_display"] if (user and user["email_display"]) else row["email"]
        return PollResponse(
            status="verified",
            token=jwt,
            user={"id": user_id, "email": display_email},
        )

    @r.get("/me", response_model=MeResponse)
    async def me(authorization: Optional[str] = Header(None)):
        payload = _require_user(authorization)
        return MeResponse(user={"id": payload["sub"], "email": payload["email"]})

    # ====== B-2/B-4: 裝置管理（自動「我的裝置群組」= 同 user_id 下的所有 device 列）======

    @r.post("/devices/register", response_model=DeviceInfo)
    async def register_device(body: DeviceRegisterBody, authorization: Optional[str] = Header(None)):
        """登入後呼叫：把當前裝置註冊到使用者的「我的裝置」群組。

        Dedupe 策略（依序）：
          1. (user_id, fingerprint_hash, pubkey) — 同一個安裝（指紋＋公鑰都相同）
          2. (user_id, pubkey) — legacy fallback（指紋變了但 keypair 還在 localStorage）
          3. 都沒命中 → 檢查 tier limit（free=2, pro=10）
             - 滿了 → 409 + 現有 device list（讓 client 顯示「替換裝置」gate）
             - 沒滿 → INSERT 新 row
        硬上限 16 台仍存在（防 abuse）。
        """
        payload = _require_user(authorization)
        user_id = payload["sub"]
        now = int(time.time())

        def _row_to_info(row, last_seen):
            return DeviceInfo(
                id=row["id"],
                label=row["label"],
                user_agent=row["user_agent"],
                pubkey=row["pubkey"],
                first_seen_at=row["first_seen_at"],
                last_seen_at=last_seen,
            )

        # Step 1: 同一個安裝（指紋＋公鑰都相同）→ 更新它自己那筆。
        # 指紋相同、公鑰不同 → **一律當成另一台**，往下新增（稽核 B4）。以前「既有那筆 last_seen 超過 90 秒」
        # 就覆蓋它的公鑰（當成重裝），但 last_seen 只在註冊／開機時更新，使用中的裝置幾乎都超過 90 秒；
        # 指紋只有 CPU 核心數、記憶體、平台名稱（同一台機器的各瀏覽器設計上都相同），Mac 上的 Chrome 與
        # Safari、或 Mac 與 iPad 的 Safari 很容易同指紋 → 兩台合併成同一個裝置 id：彼此的訊息被當成
        # 「自己的」丟掉、前一台換 MQTT token 被拒、撤銷一台等於撤銷兩台。
        # 代價：重裝（新公鑰）會留下一筆舊裝置，使用者在裝置清單移除；tier 上限滿了（免費版 2 台）會出現
        # 替換裝置畫面。不自動刪除任何裝置。
        if body.fingerprint_hash:
            fp_result = None
            with get_db() as conn:
                def _bind_session_and_touch(dev_id, label, ua, pubkey, first_seen, do_pubkey=None):
                    conn.execute(
                        "UPDATE aegistrans_devices SET last_seen_at=?, "
                        "pubkey=COALESCE(?, pubkey), label=?, user_agent=COALESCE(?, user_agent) WHERE id=?",
                        (now, do_pubkey, label, ua, dev_id)
                    )
                    if payload.get("sid"):  # CR-01：綁 session→device（同 conn，避免巢狀 get_db 鎖死）
                        conn.execute(
                            "UPDATE aegistrans_sessions SET device_id=? WHERE sid=? AND revoked_at IS NULL",
                            (dev_id, payload["sid"]),
                        )
                    return DeviceInfo(id=dev_id, label=label, user_agent=ua or None,
                                      pubkey=pubkey, first_seen_at=first_seen, last_seen_at=now)

                # (a) 先精確找「同指紋 + 同 pubkey」的 row → 就是這個 install 自己 → 只更新它。
                #     多 row（併發後已分裂）時避免「LIMIT 1 永遠抓到 A、把 A 覆蓋成 B」的錯亂（review 2026-07-16）。
                exact = None
                if body.pubkey:
                    exact = conn.execute(
                        "SELECT id, label, user_agent, pubkey, first_seen_at FROM aegistrans_devices "
                        "WHERE user_id=? AND fingerprint_hash=? AND pubkey=? LIMIT 1",
                        (user_id, body.fingerprint_hash, body.pubkey)
                    ).fetchone()
                if exact:
                    new_label = (body.label[:80] if body.label else exact["label"])
                    fp_result = _bind_session_and_touch(
                        exact["id"], new_label, body.user_agent or exact["user_agent"],
                        exact["pubkey"], exact["first_seen_at"], do_pubkey=None,  # pubkey 不變（就是它自己）
                    )
                elif body.pubkey and not conn.execute(
                    "SELECT 1 FROM aegistrans_devices WHERE user_id=? AND pubkey=? LIMIT 1", (user_id, body.pubkey)
                ).fetchone():
                    # (b) 同指紋、還沒有公鑰的那筆（舊版用戶端註冊時沒帶公鑰）：就地補上公鑰，跟舊伺服器一樣。660fdbb 之後
                    #     它被當成另一台 → 多一筆，帳號滿了就 409（AegisTrans 審查 G，對應 TofuTalk dd36777）。沒有公鑰的那筆
                    #     沒有任何裝置的身分，補上不會把兩台合併；這個 session 綁的那筆優先。有公鑰的同指紋那筆照舊不碰（稽核 B4）。
                    #     帳號裡已經有一筆帶這把公鑰（同一個安裝、指紋變了）就不補，往下走 Step 2 回那一筆（審查 round-3
                    #     MEDIUM-3，對應 TofuTalk af1a481：以前照補 → 兩筆同公鑰，撤銷畫面上那筆後另一筆還帶著它，綁在那筆的
                    #     session 也照樣有效）。
                    keyless = conn.execute(
                        "SELECT id, label, user_agent, first_seen_at FROM aegistrans_devices "
                        "WHERE user_id=? AND fingerprint_hash=? AND pubkey IS NULL "
                        "ORDER BY (id = ?) DESC, last_seen_at DESC LIMIT 1",
                        (user_id, body.fingerprint_hash, payload.get("_device_id") or ""),
                    ).fetchone()
                    if keyless:
                        new_label = (body.label[:80] if body.label else keyless["label"])
                        fp_result = _bind_session_and_touch(
                            keyless["id"], new_label, body.user_agent or keyless["user_agent"],
                            body.pubkey, keyless["first_seen_at"], do_pubkey=body.pubkey,
                        )
                # else：同指紋但公鑰不同（或沒帶公鑰）→ 不動任何既有 row，往下走 Step 2/3
            if fp_result is not None:
                return fp_result

        # Step 2: legacy dedupe by pubkey (for clients still on v1 fingerprint)
        if body.pubkey:
            with get_db() as conn:
                existing = conn.execute(
                    "SELECT id, label, user_agent, pubkey, first_seen_at FROM aegistrans_devices "
                    "WHERE user_id=? AND pubkey=? LIMIT 1",
                    (user_id, body.pubkey)
                ).fetchone()
                if existing:
                    # 同 pubkey：補上 fingerprint_hash 讓下次走 step 1，順便更新 label
                    new_label = (body.label[:80] if body.label else existing["label"])
                    conn.execute(
                        "UPDATE aegistrans_devices SET last_seen_at=?, "
                        "fingerprint_hash=COALESCE(fingerprint_hash, ?), "
                        "label=?, user_agent=COALESCE(?, user_agent) WHERE id=?",
                        (now, body.fingerprint_hash, new_label, body.user_agent, existing["id"])
                    )
                    if payload.get("sid"):  # CR-01：綁 session→device（同 conn）
                        conn.execute(
                            "UPDATE aegistrans_sessions SET device_id=? WHERE sid=? AND revoked_at IS NULL",
                            (existing["id"], payload["sid"]),
                        )
                    return DeviceInfo(
                        id=existing["id"],
                        label=new_label,
                        user_agent=body.user_agent or existing["user_agent"],
                        pubkey=existing["pubkey"],
                        first_seen_at=existing["first_seen_at"],
                        last_seen_at=now,
                    )

        # Step 3: 沒命中 = 真的新裝置 → 檢查 tier limit
        # 讀 tier（free=2 / pro=10），讀現有 device 列
        #
        # 2026-05-10 fix: 加 email fallback。如果 JWT sub 對應的 user_id 在 DB 找不到
        # （殭屍 JWT — user 被砍重建後舊 JWT 仍 valid），用 JWT 內 email 找真實 user_id。
        # 避免「license 設了但 user 看不到 Pro」的情況。
        with get_db() as conn:
            current_user = conn.execute(
                "SELECT id FROM aegistrans_users WHERE id=?", (user_id,)
            ).fetchone()
            if not current_user:
                jwt_email = (payload.get("email") or "").lower()
                if jwt_email:
                    real = conn.execute(
                        "SELECT id FROM aegistrans_users WHERE email=?", (jwt_email,)
                    ).fetchone()
                    if real:
                        print(f"[REGISTER] zombie JWT sub={user_id[:8]}... → resolved via email to {real['id'][:8]}...", flush=True)
                        user_id = real["id"]

            lic = conn.execute(
                "SELECT tier, expires_at FROM aegistrans_licenses WHERE user_id=?",
                (user_id,)
            ).fetchone()
            print(f"[REGISTER] user_id={user_id[:8]}... license={lic['tier'] if lic else 'NONE'}", flush=True)
            tier = "free"
            if lic and lic["tier"] in ("pro_monthly", "pro_yearly", "pro_lifetime"):
                # 過期不算 pro
                exp = lic["expires_at"]
                if lic["tier"] == "pro_lifetime" or (exp and exp > now):
                    tier = lic["tier"]
            tier_limit = 2 if tier == "free" else 10
            HARD_CAP = 16

            existing_devices = conn.execute(
                "SELECT id, label, user_agent, pubkey, first_seen_at, last_seen_at "
                "FROM aegistrans_devices WHERE user_id=? ORDER BY last_seen_at DESC",
                (user_id,)
            ).fetchall()
            count = len(existing_devices)

            if count >= HARD_CAP:
                raise HTTPException(
                    status_code=422,
                    detail=f"已達絕對裝置上限（{HARD_CAP} 台）。請聯繫支援。",
                )
            if count >= tier_limit:
                # tier 不足 → 409 + 現有 device 列，給 client 開「替換裝置 gate」
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "device_limit_exceeded",
                        "tier": tier,
                        "tier_limit": tier_limit,
                        "device_count": count,
                        # 這個 session 綁定的那台（撤銷它＝撤銷正在登入的這個 session）：替換畫面標成「本機」（審查 G）
                        "current_device_id": payload.get("_device_id"),
                        "devices": [
                            {
                                "id": d["id"],
                                "label": d["label"],
                                "user_agent": d["user_agent"],
                                "first_seen_at": d["first_seen_at"],
                                "last_seen_at": d["last_seen_at"],
                            }
                            for d in existing_devices
                        ],
                    },
                )

        # OK to insert
        device_id = secrets.token_hex(16)
        with get_db() as conn:
            conn.execute(
                "INSERT INTO aegistrans_devices "
                "(id, user_id, label, user_agent, pubkey, fingerprint_hash, first_seen_at, last_seen_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (device_id, user_id, body.label[:80], (body.user_agent or "")[:400],
                 body.pubkey, body.fingerprint_hash, now, now)
            )
        _link_session_to_device(payload, device_id)  # CR-01：綁 session→device（with 區塊外，無巢狀）
        return DeviceInfo(
            id=device_id,
            label=body.label[:80],
            user_agent=body.user_agent,
            pubkey=body.pubkey,
            first_seen_at=now,
            last_seen_at=now,
        )

    @r.put("/devices/{device_id}/pubkey")
    async def set_device_pubkey(device_id: str, body: DevicePubkeyBody, authorization: Optional[str] = Header(None)):
        """補登/更新裝置的 Ed25519 公鑰（用於 MQTT presence + WebRTC handshake）。

        只能改這個 session 綁定的那台（稽核 B20）：以前任何已登入裝置都能把別台的公鑰換成自己的，
        其他裝置就會改跟這把金鑰配對。
        """
        payload = _require_user(authorization)
        if payload.get("_device_id") != device_id:
            raise HTTPException(403, "A device can only change its own pubkey")
        with get_db() as conn:
            cursor = conn.execute(
                "UPDATE aegistrans_devices SET pubkey=? WHERE id=? AND user_id=?",
                (body.pubkey, device_id, payload["sub"])
            )
            if cursor.rowcount == 0:
                raise HTTPException(404, "Device not found")
        return {"ok": True}

    @r.get("/devices", response_model=DeviceListResponse)
    async def list_devices(authorization: Optional[str] = Header(None)):
        """列出當前使用者的所有裝置。"""
        payload = _require_user(authorization)
        with get_db() as conn:
            rows = conn.execute(
                "SELECT id, label, user_agent, pubkey, first_seen_at, last_seen_at FROM aegistrans_devices "
                "WHERE user_id=? ORDER BY last_seen_at DESC",
                (payload["sub"],)
            ).fetchall()
        return DeviceListResponse(devices=[
            DeviceInfo(
                id=row["id"],
                label=row["label"],
                user_agent=row["user_agent"],
                pubkey=row["pubkey"],
                first_seen_at=row["first_seen_at"],
                last_seen_at=row["last_seen_at"],
            )
            for row in rows
        ])

    @r.delete("/devices/{device_id}")
    async def revoke_device(device_id: str, authorization: Optional[str] = Header(None)):
        """撤銷裝置（從「我的裝置」群組中移除）。
        CR-01 (2026-06-24)：不再只是 soft revocation —— 連帶撤銷綁定此 device 的 session，
        被撤銷裝置的 JWT 下次打 API（如 cold-start pingDevice）即 401 → client 自動登出。"""
        payload = _require_user(authorization)
        now = int(time.time())
        with get_db() as conn:
            cursor = conn.execute(
                "DELETE FROM aegistrans_devices WHERE id=? AND user_id=?",
                (device_id, payload["sub"])
            )
            if cursor.rowcount == 0:
                raise HTTPException(404, "Device not found")
            # CR-01：撤銷綁定此 device 的所有 session
            conn.execute(
                "UPDATE aegistrans_sessions SET revoked_at=? WHERE device_id=? AND user_id=? AND revoked_at IS NULL",
                (now, device_id, payload["sub"])
            )
        return {"ok": True}

    # ====== Phase 1 收尾 A：帳號刪除（GDPR 資料刪除權） ======

    @r.delete("/users/me")
    async def delete_account(authorization: Optional[str] = Header(None)):
        """刪除使用者帳號 + cascade 所有 server-side metadata。

        Cascade 範圍：
          - aegistrans_users（user 本身）
          - aegistrans_devices（所有 device rows）
          - aegistrans_sessions（所有登入 session）
          - aegistrans_magic_tokens（未用過的 magic links）
          - aegistrans_licenses（商店交易與 tier 對應）
          - aegistrans_purchases

        留下墓碑 aegistrans_deleted_users（只有隨機帳號 id＋時間，session 壽命後清掉）：之後這個帳號的 JWT 得到
        401「Account no longer exists」；沒有墓碑卻找不到帳號 → 503（審查 F）。

        **不影響**：使用者各裝置上的本機資料（IndexedDB / SQLite）。
        Frontend 應該在收到成功 response 後自行清空 localStorage 並登出。
        """
        payload = _require_user(authorization)
        user_id = payload["sub"]
        email = payload.get("email")
        with get_db() as conn:
            # SQLite 連線未全域開 PRAGMA foreign_keys，不能只相信 schema 的 ON DELETE CASCADE；
            # 所有 user-owned rows 明確刪除，避免刪帳後留下 purchase/license orphan。
            conn.execute("DELETE FROM aegistrans_devices WHERE user_id=?", (user_id,))
            conn.execute("DELETE FROM aegistrans_sessions WHERE user_id=?", (user_id,))  # CR-01
            conn.execute("DELETE FROM aegistrans_licenses WHERE user_id=?", (user_id,))
            conn.execute("DELETE FROM aegistrans_purchases WHERE user_id=?", (user_id,))
            if email:
                conn.execute("DELETE FROM aegistrans_magic_tokens WHERE email=?", (email,))
            cursor = conn.execute("DELETE FROM aegistrans_users WHERE id=?", (user_id,))
            if cursor.rowcount == 0:
                raise HTTPException(404, "User not found")
            # 墓碑：之後這個帳號的 JWT 得到「Account no longer exists」（審查 F）；超過 session 壽命的舊墓碑順便清掉
            now = int(time.time())
            conn.execute("INSERT OR REPLACE INTO aegistrans_deleted_users (id, deleted_at) VALUES (?, ?)", (user_id, now))
            conn.execute("DELETE FROM aegistrans_deleted_users WHERE deleted_at < ?", (now - SESSION_TTL_SECONDS,))
        return {"ok": True, "user_id": user_id}

    # ====== C-2: Password 登入 ======

    @r.post("/password/login", response_model=VerifyResponse)
    async def password_login(body: PasswordLoginBody, request: Request):
        """email + password → JWT。
        C-3 加 rate-limit：失敗 5 次 / 15 分鐘 / 同 (email, ip) → 鎖 5 分鐘（429）。"""
        email = normalize_email(body.email)
        if not is_valid_email(email):
            return VerifyResponse(ok=False, error="Email 格式不正確")

        ip = _client_ip(request)
        # C-3：在 verify 之前先檢查 lockout（避免攻擊者用密碼字典硬刷）
        if _is_login_locked(email, ip):
            raise HTTPException(429, "登入嘗試過多，請稍後再試（5 分鐘）")

        with get_db() as conn:
            row = conn.execute(
                "SELECT id, email, password_hash, email_display FROM aegistrans_users WHERE email=?",
                (email,)
            ).fetchone()

        if not row or not row["password_hash"]:
            # 帳號不存在 OR 還沒設密碼 → 不洩漏訊息（也記失敗以阻擋帳號枚舉 + brute force）
            _record_login_attempt(email, ip, success=False)
            return VerifyResponse(ok=False, error="登入失敗。請確認 email 與密碼，或使用登入連結。")

        if not verify_password(body.password, row["password_hash"]):
            _record_login_attempt(email, ip, success=False)
            return VerifyResponse(ok=False, error="登入失敗。請確認 email 與密碼。")

        # 成功：記成功 attempt + 更新 last_seen_at
        _record_login_attempt(email, ip, success=True)
        now = int(time.time())
        with get_db() as conn:
            conn.execute("UPDATE aegistrans_users SET last_seen_at=? WHERE id=?", (now, row["id"]))
            sid = _create_session(conn, row["id"], now)  # CR-01：可撤銷 session

        jwt = sign_jwt({
            "sub": row["id"],
            "email": row["email"],
            "sid": sid,
            "iat": now,
            "exp": now + SESSION_TTL_SECONDS,
        })
        return VerifyResponse(
            ok=True,
            token=jwt,
            # 顯示用 email 用使用者寫的原樣(email_display);JWT/比對仍用正規化 email。
            user={"id": row["id"], "email": row["email_display"] or row["email"]},
        )

    @r.post("/password/set")
    async def password_set(body: PasswordSetBody, authorization: Optional[str] = Header(None)):
        """已登入使用者設定/修改密碼（首次設或改密碼）。
        C-3 step-up：已設過密碼者必須提供 current_password 才能改（防 stolen-JWT 改密碼接管）。"""
        payload = _require_user(authorization)
        user_id = payload["sub"]
        # 讀目前是否已設密碼
        with get_db() as conn:
            existing = conn.execute(
                "SELECT password_hash FROM aegistrans_users WHERE id=?",
                (user_id,)
            ).fetchone()
        if existing and existing["password_hash"]:
            # 已設過密碼 → 改密碼必須驗證 current_password
            if not body.current_password:
                raise HTTPException(400, "改密碼必須提供 current_password")
            if not verify_password(body.current_password, existing["password_hash"]):
                raise HTTPException(401, "目前密碼錯誤")
        # 首次設或驗證通過 → 寫入新 hash
        h = hash_password(body.password)
        with get_db() as conn:
            conn.execute(
                "UPDATE aegistrans_users SET password_hash=? WHERE id=?",
                (h, user_id)
            )
        return {"ok": True}

    @r.post("/password/reset")
    async def password_reset(body: PasswordSetBody, authorization: Optional[str] = Header(None)):
        """忘記密碼重設:不需舊密碼,但需 (a) 有效 JWT + (b) 該 email 在近 15 分鐘內
        剛完成一次 magic-link 驗證(verified + used)。這樣被偷的 password-login JWT
        無法改密碼接管(它沒有近期 magic-link);只有剛用 Email 連結驗證 email 擁有權
        的人能重設。"""
        payload = _require_user(authorization)
        user_id = payload["sub"]
        email = (payload.get("email") or "").lower()
        now = int(time.time())
        RESET_WINDOW = 15 * 60  # 15 min,與 MAGIC_TTL_SECONDS 一致
        with get_db() as conn:
            tok = conn.execute(
                "SELECT used_at FROM aegistrans_magic_tokens "
                "WHERE email=? AND verified_at IS NOT NULL AND used_at IS NOT NULL "
                "ORDER BY used_at DESC LIMIT 1",
                (email,)
            ).fetchone()
        if not tok or tok["used_at"] is None or (now - tok["used_at"]) > RESET_WINDOW:
            raise HTTPException(403, "重設密碼前請先用 Email 連結驗證(連結驗證後 15 分鐘內有效)")
        h = hash_password(body.password)
        with get_db() as conn:
            conn.execute(
                "UPDATE aegistrans_users SET password_hash=? WHERE id=?",
                (h, user_id)
            )
        return {"ok": True}

    @r.get("/password/status")
    async def password_status(authorization: Optional[str] = Header(None)):
        """查詢當前帳號是否已設定 password。"""
        payload = _require_user(authorization)
        with get_db() as conn:
            row = conn.execute(
                "SELECT password_hash FROM aegistrans_users WHERE id=?",
                (payload["sub"],)
            ).fetchone()
        return {"has_password": bool(row and row["password_hash"])}

    @r.post("/mqtt/token", response_model=MqttTokenResponse)
    async def mqtt_token(body: MqttTokenRequest, authorization: Optional[str] = Header(None)):
        """簽發 MQTT JWT（給 EMQX broker 驗）。需 user JWT 認證。

        C-3：MQTT token 必須綁定已註冊且未撤銷的裝置（防 revoked-device 仍能取 token）。
        - 必須帶 device_id
        - (user_id, device_id) 必須存在於 aegistrans_devices（亦即未被 DELETE / revoke）

        撤銷裝置後，這台裝置嘗試 refresh MQTT token 會被 403；broker 端現有 token TTL 1 小時
        內過期後就斷。MQTT broker 自身也是用 MQTT_JWT_SECRET 驗 token，本 endpoint 只是 server
        端的 issuance gate — 第二道防線是 broker 端的 token expiry。

        安全修（2026-06-05）：token 的 sub 必須對應「該裝置註冊的 pubkey」，**不能信任 client
        任意傳來的 pubkeyHash**。否則任何已登入用戶都可請求 sub=SHA256(victim_safeKey)，拿到一張
        對受害者 signaling topic 合法簽名的 broker token（讀對方 inbox / 偽造 presence）。早期因
        「URL-safe base64 vs 原 base64 重算對不上」放棄了綁定 — 那是可修的編碼 bug（見 pubkey_hash
        鏡射 mqtt.ts 的字串轉換），不是放棄 binding 的理由。
        """
        user_payload = _require_user(authorization)
        if not body.device_id:
            raise HTTPException(400, "device_id required")
        # session 已綁定裝置 → 只能替那台拿通行證（稽核 B20）；未綁定（註冊前）照舊只查帳號
        bound = user_payload.get("_device_id")
        if bound and bound != body.device_id:
            raise HTTPException(403, "Token can only be issued for this session's device")
        with get_db() as conn:
            row = conn.execute(
                "SELECT pubkey FROM aegistrans_devices WHERE user_id=? AND id=?",
                (user_payload["sub"], body.device_id)
            ).fetchone()
        if not row:
            # 裝置不存在或已被撤銷
            raise HTTPException(403, "Device not registered or revoked")
        stored_pubkey = row["pubkey"]
        if not stored_pubkey:
            # 沒有註冊 pubkey 的 legacy 裝置 → 無法綁定 → 拒絕。client 每次啟動會先
            # register_device（帶 pubkey）再取 token，下次啟動就會補上 pubkey 後放行。
            raise HTTPException(403, "Device pubkey not registered; re-register required")
        expected_hash = pubkey_hash(stored_pubkey)
        if not hmac.compare_digest(expected_hash, body.pubkeyHash or ""):
            raise HTTPException(403, "pubkeyHash does not match registered device")
        # C-1：把此 client 的 MQTT 授權限縮到「自己帳號」的 topic。用帳號命名空間 wildcard
        # `mist/acct/{userId}/#` 一條覆蓋本帳號所有裝置的 inbox/presence（client 端 mqtt.ts
        # 把 per-device topic 建成 mist/acct/{userId}/user/{safeKey}/...）。
        #
        # 為何不逐裝置列舉 pubkey：舊做法 `mist/user/{safeKey}/#` per-device 是「發 token 當下的
        # 裝置快照」。上第 N 台新裝置時，前 N-1 台的 token ACL 不含新裝置 topic → 收發不到新裝置，
        # 直到它們 token 過期重簽（~1h）。改成帳號 wildcard 後，新裝置 topic 天生落在
        # mist/acct/{userId}/# 底下 → 既有 token 立即可達，無收斂延遲。跨帳號隔離靠 userId 前綴保留。
        #
        # 稽核 B2：拿掉全帳號共用的 `mist/broadcast` 的讀寫權。它讓任何帳號都能對所有在線 client 送任何訊息類型
        # （from 自填）；AegisTrans 沒有任何正當程式用它，client 的廣播頻道已改在 mist/acct/{uid}/ 底下。
        # 審查 B1：`mist/broadcast` 保留「只能訂閱」。正式版 cc682d7 的 client 連上時一定會訂它（從不發布），
        # broker 的 deny_action 不在 repo 裡：若是 disconnect，拒絕訂閱會把每台舊版 client 一連上就踢掉。
        # 只准訂閱不准發布 → 誰都不能往裡面送，舊版訂了也收不到東西；新版連上時退訂，收到的也丟（mqtt.ts isOwnTopic）。
        uid = user_payload["sub"]
        acl = {
            "all": [
                f"mist/acct/{uid}/#",
                f"mist/group/aegistrans:{uid}:my-devices",
            ],
            "sub": ["aegis/device/+/kicked", "mist/broadcast"],
            # 商用化收尾：移除 `aegis/debug/#` 發布權。它讓任何帳號都能往任意裝置的 debug 子topic
            # 灌 log（毒化共用 VPS debug collector），寫入範圍遠超自己裝置。AegisTrans 的 remoteDebugger
            # 走「另一張」token（/api/mqtt/token，共用 broker），不依賴這個 grant → 拿掉不影響除錯。
            "pub": [],
        }
        # 簽 server 端重算的 hash（已驗證 == client 傳來的），不直接信任 client 字串。
        token, exp = sign_mqtt_jwt(expected_hash, acl=acl)
        return MqttTokenResponse(token=token, expiresAt=exp)

    @r.post("/devices/{device_id}/ping")
    async def ping_device(device_id: str, authorization: Optional[str] = Header(None)):
        """心跳：更新 last_seen_at。前端定期呼叫。"""
        payload = _require_user(authorization)
        now = int(time.time())
        with get_db() as conn:
            cursor = conn.execute(
                "UPDATE aegistrans_devices SET last_seen_at=? WHERE id=? AND user_id=?",
                (now, device_id, payload["sub"])
            )
            if cursor.rowcount == 0:
                raise HTTPException(404, "Device not found")
        return {"ok": True, "last_seen_at": now}

    return r


# ===== Schema B：兩層 entitlement helpers =====
_TIER_ORDER = {"pro_monthly": 1, "pro_yearly": 2, "pro_lifetime": 3}


def _tier_rank(tier: str, expires_at: Optional[int]):
    """entitlement 高低：lifetime > yearly > monthly（同階比到期日，None=lifetime=無限大）。"""
    if tier not in PRO_TIERS:
        return (0, 0.0)
    return (_TIER_ORDER.get(tier, 1), float("inf") if expires_at is None else float(expires_at))


def _valid_purchases(conn, user_id: str, now: int):
    """仍賦予 entitlement 的購買列：active（續訂中）或 cancelled（自動續訂已關但付費期內），
    且未過期。expired/refunded 一律不算。"""
    rows = conn.execute(
        "SELECT * FROM aegistrans_purchases "
        "WHERE user_id=? AND state IN ('active','cancelled')",
        (user_id,),
    ).fetchall()
    return [r for r in rows if r["expires_at"] is None or r["expires_at"] > now]


def _recompute_entitlement(conn, user_id: str) -> SubscriptionStatusResponse:
    """把 purchases 投影成 licenses 單列（帳號目前最高有效 entitlement）。
    每次 purchases 變動後呼叫；licenses 的既有讀取端（status/register_device）不用改。"""
    now = int(time.time())
    valid = _valid_purchases(conn, user_id, now)
    if not valid:
        conn.execute("DELETE FROM aegistrans_licenses WHERE user_id=?", (user_id,))
        return SubscriptionStatusResponse(tier="free", is_pro=False)
    best = max(valid, key=lambda r: _tier_rank(r["tier"], r["expires_at"]))
    existing = conn.execute(
        "SELECT user_id FROM aegistrans_licenses WHERE user_id=?", (user_id,)
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE aegistrans_licenses SET tier=?, source=?, expires_at=?, external_id=?, "
            "updated_at=? WHERE user_id=?",
            (best["tier"], best["source"], best["expires_at"], best["external_id"], now, user_id),
        )
    else:
        conn.execute(
            "INSERT INTO aegistrans_licenses (user_id, tier, source, expires_at, external_id, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
            (user_id, best["tier"], best["source"], best["expires_at"], best["external_id"], now, now),
        )
    return SubscriptionStatusResponse(
        tier=best["tier"], is_pro=True, source=best["source"], expires_at=best["expires_at"],
    )


def _redundant_subscriptions(conn, user_id: str, ent: SubscriptionStatusResponse):
    """比目前 entitlement 低階、仍在自動扣款（state='active' 且有到期日=訂閱）的購買列。"""
    if not ent.is_pro:
        return []
    ent_rank = _tier_rank(ent.tier, ent.expires_at)
    out = []
    for r in _valid_purchases(conn, user_id, int(time.time())):
        if r["state"] == "active" and r["expires_at"] is not None \
                and _tier_rank(r["tier"], r["expires_at"]) < ent_rank:
            out.append(RedundantSubscription(
                store=r["store"], product_id=r["product_id"],
                tier=r["tier"], expires_at=r["expires_at"],
            ))
    return out


def _status_with_redundant(conn, user_id: str, ent: SubscriptionStatusResponse) -> SubscriptionStatusResponse:
    ent.redundant_subscriptions = _redundant_subscriptions(conn, user_id, ent)
    return ent


def _cancel_redundant_google_subs(user_id: str, ent: SubscriptionStatusResponse) -> None:
    """跨商店升級：entitlement 升到 lifetime 後，把仍在自動扣款的 Google 訂閱用 API 取消
    （使用者已付的期間保留，只關自動續訂 — 同 Play 內手動取消）。Apple 做不到（政策上
    server 不能取消 Apple 訂閱）→ 留給 status 的 redundant_subscriptions 持續提醒。
    Best-effort：取消失敗不擋購買流程（錢已收），下次 verify/status 仍會列在提醒裡。"""
    if ent.tier != "pro_lifetime":
        return
    with get_db() as conn:
        rows = conn.execute(
            "SELECT external_id, product_id, store_token FROM aegistrans_purchases "
            "WHERE user_id=? AND store='google' AND state='active' "
            "AND expires_at IS NOT NULL AND tier != 'pro_lifetime'",
            (user_id,),
        ).fetchall()
    for r in rows:
        if not r["store_token"] or not r["product_id"]:
            continue  # migration 前的舊列沒存 token → 只能靠提醒
        pkg = quote(GOOGLE_PLAY_PACKAGE, safe="")
        product = quote(r["product_id"], safe="")
        token = quote(r["store_token"], safe="")
        try:
            _google_play_request(
                "POST", f"/applications/{pkg}/purchases/subscriptions/{product}/tokens/{token}:cancel"
            )
        except Exception as e:
            print(f"[IAP] auto-cancel google sub failed user={user_id[:8]}: {e}", flush=True)
            continue
        with get_db() as conn:
            conn.execute(
                "UPDATE aegistrans_purchases SET state='cancelled', updated_at=? WHERE external_id=?",
                (int(time.time()), r["external_id"]),
            )


def create_aegistrans_subscription_router() -> APIRouter:
    """訂閱狀態查詢 + dev mock + LS webhook stub。

    Phase 1A.1：
      - GET  /subscription/status              → 用 JWT 查 tier，沒 row 回 free
      - POST /subscription/dev-set-tier        → dev only（AEGISTRANS_DEV_MODE=1），給 e2e test 用
      - POST /subscription/lemonsqueezy-webhook → Phase 1B 填簽章驗證；目前回 503 stub
    """
    sub = APIRouter(prefix="/aegistrans/subscription", tags=["aegistrans-subscription"])

    @sub.get("/status", response_model=SubscriptionStatusResponse)
    async def get_status(authorization: Optional[str] = Header(None)):
        payload = _require_user(authorization)
        user_id = payload["sub"]
        # Schema B：每次讀時從 purchases 重投影（順帶自癒過期的 licenses 快照），
        # 並附上「仍在扣款的低階訂閱」提醒清單。
        with get_db() as conn:
            ent = _recompute_entitlement(conn, user_id)
            return _status_with_redundant(conn, user_id, ent)

    @sub.post("/dev-set-tier", response_model=SubscriptionStatusResponse)
    async def dev_set_tier(body: DevSetTierBody, authorization: Optional[str] = Header(None)):
        """**僅 dev mode + admin allowlist** — 直接寫 license row，給 e2e test + dogfood 用。

        C-3 雙重 gate：
          1. AEGISTRANS_DEV_MODE != "1" → 403（即使 prod 不小心開了 admin allowlist 也被擋）
          2. AEGISTRANS_DEV_ADMIN_EMAILS 不含當前 user → 403（即使 dev mode 開了，非 allowlist 也擋）
        Production 即使 AEGISTRANS_DEV_MODE 誤開也應該無 admin email match → endpoint 形同關閉。
        """
        if not AEGISTRANS_DEV_MODE:
            raise HTTPException(403, "Dev mode disabled")
        payload = _require_user(authorization)
        # C-3：admin email allowlist
        admin_emails_raw = os.environ.get("AEGISTRANS_DEV_ADMIN_EMAILS", "")
        admin_emails = {e.strip().lower() for e in admin_emails_raw.split(",") if e.strip()}
        caller_email = (payload.get("email") or "").lower()
        if not admin_emails or caller_email not in admin_emails:
            raise HTTPException(403, "Admin allowlist denied")
        user_id = payload["sub"]

        if body.tier not in VALID_TIERS:
            raise HTTPException(400, f"Invalid tier; must be one of {sorted(VALID_TIERS)}")

        now = int(time.time())
        expires_at = (now + body.expires_in_seconds) if body.expires_in_seconds else None

        # Schema B：dev 購買 = 固定 external_id 'dev-<user_id>' 的一列（不累積）。
        # tier=free → 刪 dev 列（真商店購買不動 — dev 工具不該蓋掉真 entitlement）。
        with get_db() as conn:
            if body.tier == "free":
                # 清全部 dev 列（含 migration 來的 legacy-<uid> dev 列），真商店購買不動。
                conn.execute(
                    "DELETE FROM aegistrans_purchases WHERE user_id=? AND store='dev'", (user_id,)
                )
            else:
                conn.execute(
                    "INSERT INTO aegistrans_purchases (external_id, user_id, store, product_id, "
                    "tier, state, source, expires_at, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(external_id) DO UPDATE SET tier=excluded.tier, "
                    "state=excluded.state, expires_at=excluded.expires_at, updated_at=excluded.updated_at",
                    (f"dev-{user_id}", user_id, "dev", None, body.tier, "active", "dev",
                     expires_at, now, now),
                )
            ent = _recompute_entitlement(conn, user_id)
            return _status_with_redundant(conn, user_id, ent)

    @sub.post("/verify", response_model=SubscriptionStatusResponse)
    async def verify_purchase(body: VerifyPurchaseBody, authorization: Optional[str] = Header(None)):
        """驗 StoreKit 2 簽名交易（jwsRepresentation）→ 設 tier（自家後端驗收據，不依賴第三方）。

        StoreKit 2 的 Transaction.jwsRepresentation 是 Apple 簽好、server 端可獨立驗章的交易憑證；
        用 app-store-server-library 的 SignedDataVerifier 驗（憑證鏈根到 Apple Root CA + bundleId
        + appAppleId）→ 解出 productId / 到期日 → upsert aegistrans_licenses（source=apple）。
        """
        payload = _require_user(authorization)
        user_id = payload["sub"]

        # 取 verifier（lib 未裝 / 憑證未放 → 503，不影響其他端點）
        # sandbox：全域旗標開著，或這個 user_id 在審核/dogfood 白名單裡，才接受。
        allow_sandbox = IAP_ALLOW_SANDBOX or user_id in IAP_SANDBOX_USER_IDS
        try:
            verifiers = _get_iap_verifiers(allow_sandbox)
        except Exception as e:
            raise HTTPException(503, f"IAP verification not configured: {e}")

        # 驗章：production 優先；sandbox 只在上面判定允許時才在清單裡（H-1）。
        from appstoreserverlibrary.signed_data_verifier import VerificationException
        tx = None
        tx_env = None
        for env_name, verifier in verifiers:
            try:
                tx = verifier.verify_and_decode_signed_transaction(body.signedTransaction)
                tx_env = env_name
                break
            except VerificationException:
                continue
        if tx is None:
            raise HTTPException(400, "Signed transaction failed Apple verification")

        # bundleId 已由 verifier 內部檢查；對映 productId → tier
        product_id = getattr(tx, "productId", None)
        tier = IAP_PRODUCT_TO_TIER.get(product_id)
        if not tier:
            raise HTTPException(400, f"Unknown product: {product_id}")

        now = int(time.time())
        event_signed = getattr(tx, "signedDate", None)  # ms — 亂序防呆排序鍵（與 webhook 同）
        # Schema B：tier 固定為商品對應 tier；有效性用 state 表達（entitlement 由投影算）。
        is_revocation = getattr(tx, "revocationDate", None) is not None
        exp_ms = getattr(tx, "expiresDate", None)  # 訂閱有；買斷(non-consumable)為 None
        expires_at = int(exp_ms // 1000) if exp_ms else None
        if is_revocation:
            state = "refunded"
        elif expires_at is not None and expires_at <= now:
            state = "expired"
        else:
            state = "active"

        # CR-05 (a)：appAccountToken 綁帳號。client 購買時帶 = uuid_from(user_id)（見 iap.ts），
        # Apple 把它原樣放進交易。後端重算 expected token 比對；不符 = 這筆交易屬於別的帳號 → 拒。
        # 沒帶 token（理論上不會，client 一律帶）→ 也拒，避免無主交易被任意帳號認領。
        tx_account_token = getattr(tx, "appAccountToken", None)
        expected_token = _expected_app_account_token(user_id)
        if not tx_account_token or str(tx_account_token).lower() != expected_token:
            raise HTTPException(403, "Transaction appAccountToken does not match this account")

        original_tx = getattr(tx, "originalTransactionId", None) or getattr(tx, "transactionId", "")
        external_id = f"apple-{original_tx}"

        # 來源記到 DB：sandbox 交易（只有 IAP_ALLOW_SANDBOX=1 的環境才可能走到這）標記清楚，
        # 之後查帳一眼分得出「真的付過錢」還是「測試機給的」。
        source = "apple" if tx_env == "production" else "apple_sandbox"

        with get_db() as conn:
            # CR-05 (b)：同一筆 Apple 交易不可被多個帳號認領（防 replay 到別的帳號）。
            row = conn.execute(
                "SELECT * FROM aegistrans_purchases WHERE external_id=?", (external_id,)
            ).fetchone()
            if row and row["user_id"] != user_id:
                raise HTTPException(409, "Transaction already claimed by another account")

            if row:
                # 亂序防呆（per-purchase；訂閱各週期共用 originalTransactionId = 同一列）：
                #   ① signedDate 較舊 → 舊事件，不覆蓋。
                #   ② 本交易 expiresDate < 列上現存到期日 → 舊週期事件（退款=退舊週期不標整列
                #      refunded，review 2026-07-16 情境；非退款=restore 逐筆送的舊 jws）→ 忽略。
                stale = (
                    (event_signed is not None and row["last_event_ts"] is not None
                     and event_signed < row["last_event_ts"])
                    or (expires_at is not None and row["expires_at"] is not None
                        and expires_at < row["expires_at"])
                )
                if not stale:
                    new_last_ts = event_signed if event_signed is not None else row["last_event_ts"]
                    conn.execute(
                        "UPDATE aegistrans_purchases SET tier=?, product_id=?, state=?, source=?, "
                        "expires_at=?, last_event_ts=?, updated_at=? WHERE external_id=?",
                        (tier, product_id, state, source, expires_at, new_last_ts, now, external_id),
                    )
            else:
                conn.execute(
                    "INSERT INTO aegistrans_purchases (external_id, user_id, store, product_id, "
                    "tier, state, source, expires_at, last_event_ts, created_at, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (external_id, user_id, "apple", product_id, tier, state, source,
                     expires_at, event_signed, now, now),
                )
            ent = _recompute_entitlement(conn, user_id)

        # 跨商店升級：升到 lifetime → 自動取消還在扣款的 Google 訂閱（network call，故在 DB 交易外）。
        _cancel_redundant_google_subs(user_id, ent)
        with get_db() as conn:
            return _status_with_redundant(conn, user_id, ent)

    @sub.post("/verify-google", response_model=SubscriptionStatusResponse)
    async def verify_google_purchase(body: VerifyGooglePurchaseBody, authorization: Optional[str] = Header(None)):
        """Verify a Google Play purchase token server-side, persist entitlement, then acknowledge it.

        The client never decides Pro status. The Android Publisher API response must match package,
        product and the obfuscated AegisTrans account token before the license is written.
        """
        payload = _require_user(authorization)
        user_id = payload["sub"]
        mapped_tier = GOOGLE_PLAY_PRODUCT_TO_TIER.get(body.productId)
        if not mapped_tier:
            raise HTTPException(400, "Unknown Google Play product")
        expected_type = "inapp" if mapped_tier == "pro_lifetime" else "subs"
        if body.productType != expected_type:
            raise HTTPException(400, "Product type does not match product")

        pkg = quote(GOOGLE_PLAY_PACKAGE, safe="")
        product = quote(body.productId, safe="")
        token = quote(body.purchaseToken, safe="")
        try:
            if body.productType == "subs":
                purchase = _google_play_request("GET", f"/applications/{pkg}/purchases/subscriptionsv2/tokens/{token}")
                line_items = purchase.get("lineItems") or []
                # review P2：取「使用者買的那個 product」對應的 line item，productId+expiry 成對。
                matched_pid, expires_at = _pick_google_line_item(line_items, prefer_product_id=body.productId)
                if matched_pid is None:
                    raise HTTPException(400, "Google subscription product mismatch")
                account_id = (purchase.get("externalAccountIdentifiers") or {}).get("obfuscatedExternalAccountId")
                state = purchase.get("subscriptionState")
                active_states = {
                    "SUBSCRIPTION_STATE_ACTIVE",
                    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
                    # User-cancelled subscriptions retain access until their paid expiry.
                    "SUBSCRIPTION_STATE_CANCELED",
                }
                is_paid = state in active_states and expires_at is not None and expires_at > int(time.time())
                acknowledged = purchase.get("acknowledgementState") == "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
                is_test = "testPurchase" in purchase
            else:
                purchase = _google_play_request(
                    "GET", f"/applications/{pkg}/purchases/products/{product}/tokens/{token}"
                )
                if purchase.get("productId") not in (None, body.productId):
                    raise HTTPException(400, "Google one-time product mismatch")
                account_id = purchase.get("obfuscatedExternalAccountId")
                is_paid = purchase.get("purchaseState") == 0 and purchase.get("consumptionState", 0) == 0
                expires_at = None
                acknowledged = purchase.get("acknowledgementState") == 1
                is_test = purchase.get("purchaseType") == 0
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(503, f"Google Play verification unavailable: {e}")

        if not account_id or not hmac.compare_digest(account_id.lower(), _expected_app_account_token(user_id)):
            raise HTTPException(403, "Purchase account does not match this AegisTrans account")
        if not is_paid:
            raise HTTPException(400, "Google Play purchase is not active")

        now = int(time.time())
        tier = mapped_tier
        external_id = "google-" + hashlib.sha256(body.purchaseToken.encode("utf-8")).hexdigest()
        source = "google_test" if is_test else "google"
        # Schema B：state 表達有效性。CANCELED（自動續訂已關、付費期內）記 'cancelled' —
        # 仍給 entitlement，但不再出現在「請取消」提醒裡。
        if body.productType == "subs" and state == "SUBSCRIPTION_STATE_CANCELED":
            p_state = "cancelled"
        else:
            p_state = "active"  # is_paid 已在上面驗過（非 active 直接 400）

        with get_db() as conn:
            row = conn.execute(
                "SELECT user_id FROM aegistrans_purchases WHERE external_id=?", (external_id,)
            ).fetchone()
            if row and row["user_id"] != user_id:
                raise HTTPException(409, "Purchase already claimed by another account")
            # verify 反映的是 Publisher API 當下真相 → 直接 upsert（不需亂序防呆）。
            # store_token 存原始 purchaseToken：伺服器端取消訂閱 API 需要。
            conn.execute(
                "INSERT INTO aegistrans_purchases (external_id, user_id, store, product_id, "
                "tier, state, source, store_token, expires_at, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(external_id) DO UPDATE SET tier=excluded.tier, "
                "product_id=excluded.product_id, state=excluded.state, source=excluded.source, "
                "store_token=excluded.store_token, expires_at=excluded.expires_at, "
                "updated_at=excluded.updated_at",
                (external_id, user_id, "google", body.productId, tier, p_state, source,
                 body.purchaseToken, expires_at, now, now),
            )
            ent = _recompute_entitlement(conn, user_id)

        # Google refunds unacknowledged initial purchases after three days. Acknowledge only after DB grant.
        if not acknowledged:
            try:
                if body.productType == "subs":
                    _google_play_request(
                        "POST", f"/applications/{pkg}/purchases/subscriptions/{product}/tokens/{token}:acknowledge"
                    )
                else:
                    _google_play_request(
                        "POST", f"/applications/{pkg}/purchases/products/{product}/tokens/{token}:acknowledge"
                    )
            except Exception as e:
                raise HTTPException(503, f"Purchase granted but Google acknowledgement failed: {e}")

        # 跨商店升級：升到 lifetime → 自動取消還在扣款的 Google 訂閱。
        _cancel_redundant_google_subs(user_id, ent)
        with get_db() as conn:
            return _status_with_redundant(conn, user_id, ent)

    @sub.post("/apple-notifications")
    async def apple_notifications(request: Request):
        """App Store Server Notifications V2 接收端（退款 / 撤銷 / 續訂 / 過期的非同步生命週期）。

        Apple 直接 POST `{"signedPayload": "<JWS>"}` 到這裡（在 App Store Connect 設定此 URL）。
        **不需要 user JWT** —— 驗證靠「Apple 的簽章」：只有 Apple 簽的 payload 通得過 verifier，
        任何人亂 POST 都會被 verify 擋掉。沿用 /verify 同一組 verifier（H-1：production 環境不收
        sandbox 通知，除非 IAP_ALLOW_SANDBOX=1）。

        冪等 + 順序：tier/到期日一律「由交易內容重算」（同一筆交易重送 → 同結果，天生冪等）；
        另加順序防呆——續訂類通知若帶的到期日比 DB 現存的舊，視為亂序舊訊息、忽略（不讓過期的
        舊通知把已續訂的降級）；退款 / 撤銷 / 過期一律套用。
        """
        # DoS 防護（review 2026-07-16）：公開端點（無 user JWT）。Apple 通知 body 很小（單一 JWS，
        # 通常 < 20KB）。設上限避免任意大 JSON/JWS 灌爆記憶體與驗章 CPU。先看 Content-Length 快速擋，
        # 再對實際讀入的 bytes 設限（防偽造/缺 CL 的 chunked）。
        MAX_NOTIFICATION_BYTES = 200_000  # 200KB，遠大於正常 signedPayload
        clen = request.headers.get("content-length")
        if clen is not None:
            try:
                if int(clen) > MAX_NOTIFICATION_BYTES:
                    raise HTTPException(413, "Payload too large")
            except ValueError:
                raise HTTPException(400, "Invalid Content-Length")
        raw = await request.body()
        if len(raw) > MAX_NOTIFICATION_BYTES:
            raise HTTPException(413, "Payload too large")
        try:
            body = json.loads(raw)
        except Exception:
            raise HTTPException(400, "Invalid JSON body")
        # 合法 JSON 但非 object（list/str/number）→ 下面 body.get() 會 AttributeError/500。公開端點先擋。
        if not isinstance(body, dict):
            raise HTTPException(400, "JSON body must be an object")
        signed = body.get("signedPayload")
        if not signed:
            raise HTTPException(400, "Missing signedPayload")

        # 通知端點永遠接受 sandbox 驗章：本端點只 UPDATE 既有 purchases 列（查無 external_id 直接
        # ack、不新增），entitlement 只能由需登入的 /verify 產生 → 開 sandbox 不會多給任何人權益，
        # 卻能讓審核/dogfood 帳號的 sandbox 訂閱後續事件（續訂/取消/退款）正常同步。
        try:
            verifiers = _get_iap_verifiers(allow_sandbox=True)
        except Exception as e:
            raise HTTPException(503, f"IAP verification not configured: {e}")

        from appstoreserverlibrary.signed_data_verifier import VerificationException
        payload = None
        verifier = None
        tx_env = None
        for env_name, v in verifiers:
            try:
                payload = v.verify_and_decode_notification(signed)
                verifier, tx_env = v, env_name
                break
            except VerificationException:
                continue
        if payload is None:
            # sandbox 通知打到 production（IAP_ALLOW_SANDBOX 未開）也會落這 → 400（等同 H-1）。
            raise HTTPException(400, "Notification failed Apple verification")

        ntype = getattr(payload, "rawNotificationType", None) or str(getattr(payload, "notificationType", ""))
        # Apple「發送測試通知」→ 只回 200 確認可達，不動 DB。
        if ntype == "TEST":
            return {"ok": True, "type": "TEST"}

        data = getattr(payload, "data", None)
        signed_tx = getattr(data, "signedTransactionInfo", None) if data else None
        if not signed_tx:
            # 有些通知只帶 renewalInfo（如 DID_CHANGE_RENEWAL_PREF）→ 無交易可同步，直接 ack。
            return {"ok": True, "type": ntype, "note": "no transaction info"}
        try:
            tx = verifier.verify_and_decode_signed_transaction(signed_tx)
        except VerificationException:
            raise HTTPException(400, "Transaction info failed verification")

        original_tx = getattr(tx, "originalTransactionId", None) or getattr(tx, "transactionId", "")
        external_id = f"apple-{original_tx}"
        now = int(time.time())
        # 通知簽發時間(ms) — 亂序防呆排序鍵（晚到的舊通知 signedDate 較舊 → 忽略）。
        event_signed = getattr(payload, "signedDate", None)
        subtype = getattr(payload, "rawSubtype", None) or str(getattr(payload, "subtype", "") or "")

        # Schema B：由交易 + 通知類型算這筆購買的 state（tier 固定為商品 tier；entitlement 由投影算）。
        product_id = getattr(tx, "productId", None)
        mapped_tier = IAP_PRODUCT_TO_TIER.get(product_id)
        if not mapped_tier:
            return {"ok": True, "type": ntype, "note": f"unknown product {product_id}"}
        exp_ms = getattr(tx, "expiresDate", None)  # 訂閱有；買斷(non-consumable)為 None
        new_exp = int(exp_ms // 1000) if exp_ms else None
        if getattr(tx, "revocationDate", None) or ntype in ("REFUND", "REVOKE"):
            new_state = "refunded"
        elif ntype in ("EXPIRED", "GRACE_PERIOD_EXPIRED"):
            new_state = "expired"
        elif ntype == "DID_CHANGE_RENEWAL_STATUS":
            # 使用者關/開自動續訂（跨商店升級後「引導取消 Apple 訂閱」的收尾訊號 —
            # 收到 DISABLED 才把 client 的持續提醒收掉）。付費期內仍有效。
            new_state = "cancelled" if "DISABLED" in subtype else "active"
        else:
            new_state = "active" if (new_exp is None or new_exp > now) else "expired"

        source = "apple" if tx_env == "production" else "apple_sandbox"

        with get_db() as conn:
            # 用 external_id 找到當初 /verify 建立的 purchases 列（→ user_id）。appAccountToken 是
            # 單向雜湊、無法反查使用者；client 端 /verify 是「首次購買」主路徑，通知是之後變動的補償。
            # Schema B 後每筆購買各自一列 — 不再有「另一筆購買把 token 蓋掉 → 通知查無」的洞。
            row = conn.execute(
                "SELECT user_id, tier, expires_at, last_event_ts FROM aegistrans_purchases WHERE external_id=?",
                (external_id,),
            ).fetchone()
            if not row:
                return {"ok": True, "type": ntype, "note": "no matching purchase (client /verify is primary)"}

            user_id = row["user_id"]
            stored_exp = row["expires_at"]
            last_ts = row["last_event_ts"]
            is_downgrade = new_state in ("refunded", "expired")

            # 亂序防呆①（所有事件，含降級）：晚到的舊通知 signedDate 較舊 → 忽略。
            if event_signed is not None and last_ts is not None and event_signed < last_ts:
                return {"ok": True, "type": ntype, "note": "stale notification ignored (older signedDate)"}

            # 亂序防呆②（非降級續訂）：新到期日比現存舊 → 舊通知，忽略。
            if not is_downgrade and new_exp is not None and stored_exp is not None and new_exp < stored_exp:
                return {"ok": True, "type": ntype, "note": "stale notification ignored (older expiry)"}

            # 亂序防呆③（降級的 transaction-level 防線；signedDate 缺失時仍擋）：
            # 造成降級的交易到期日早於列上現存到期日 → 現存來自更晚的續訂 → 忽略此降級
            # （「退款舊週期 A、新週期 B 仍有效」情境，review 2026-07-16）。買斷退款無 expiresDate
            # → guard 不觸發、照常降級。
            if is_downgrade and stored_exp is not None and new_exp is not None and new_exp < stored_exp:
                return {"ok": True, "type": ntype, "note": "stale downgrade ignored (current entitlement from a later txn)"}

            new_last_ts = event_signed if event_signed is not None else last_ts
            conn.execute(
                "UPDATE aegistrans_purchases SET tier=?, product_id=?, state=?, source=?, "
                "expires_at=?, last_event_ts=?, updated_at=? WHERE external_id=?",
                (mapped_tier, product_id, new_state, source, new_exp, new_last_ts, now, external_id),
            )
            ent = _recompute_entitlement(conn, user_id)

        return {"ok": True, "type": ntype, "user": user_id[:8], "state": new_state, "tier": ent.tier}

    @sub.post("/google-notifications")
    async def google_notifications(request: Request):
        """Authenticated Google Cloud Pub/Sub push endpoint for Play Billing RTDN.

        RTDN contains only a purchase token and change type. We always query Android Publisher API
        for current truth before changing a license; the notification body alone never grants Pro.
        """
        max_bytes = 100_000
        raw = await request.body()
        if len(raw) > max_bytes:
            raise HTTPException(413, "Payload too large")

        if not GOOGLE_PUBSUB_AUDIENCE or not GOOGLE_PUBSUB_SERVICE_ACCOUNT:
            raise HTTPException(503, "Google Pub/Sub authentication not configured")
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(401, "Missing Pub/Sub bearer token")
        try:
            from google.oauth2 import id_token
            from google.auth.transport.requests import Request as GoogleAuthRequest
            claims = id_token.verify_oauth2_token(
                auth[7:], GoogleAuthRequest(), GOOGLE_PUBSUB_AUDIENCE
            )
        except Exception:
            raise HTTPException(401, "Invalid Pub/Sub bearer token")
        if claims.get("email") != GOOGLE_PUBSUB_SERVICE_ACCOUNT or claims.get("email_verified") is not True:
            raise HTTPException(403, "Unexpected Pub/Sub service account")

        try:
            envelope = json.loads(raw)
            encoded = envelope["message"]["data"]
            notice = json.loads(base64.b64decode(encoded, validate=True))
        except Exception:
            raise HTTPException(400, "Invalid Pub/Sub message")
        if notice.get("packageName") != GOOGLE_PLAY_PACKAGE:
            raise HTTPException(400, "Unexpected package")
        if "testNotification" in notice:
            return {"ok": True, "type": "TEST"}

        sub_notice = notice.get("subscriptionNotification")
        one_notice = notice.get("oneTimeProductNotification")
        if sub_notice:
            purchase_token = sub_notice.get("purchaseToken")
            product_type = "subs"
            notification_type = int(sub_notice.get("notificationType", 0))
            requested_product = None  # subscriptionsv2 returns authoritative line items
        elif one_notice:
            purchase_token = one_notice.get("purchaseToken")
            product_type = "inapp"
            notification_type = int(one_notice.get("notificationType", 0))
            requested_product = one_notice.get("sku")
        else:
            # Voided/pending-refund message types do not carry enough state for this first integration.
            # Acknowledge the push; periodic reconciliation remains the fallback.
            return {"ok": True, "note": "unsupported notification type"}
        if not purchase_token or len(purchase_token) > 4096:
            raise HTTPException(400, "Missing purchase token")

        external_id = "google-" + hashlib.sha256(purchase_token.encode("utf-8")).hexdigest()
        with get_db() as conn:
            row = conn.execute(
                "SELECT user_id, tier, source, expires_at, last_event_ts FROM aegistrans_purchases WHERE external_id=?",
                (external_id,),
            ).fetchone()
        if not row:
            # Client /verify-google is the first-purchase path and creates the token→user binding.
            return {"ok": True, "note": "no matching purchase"}

        pkg = quote(GOOGLE_PLAY_PACKAGE, safe="")
        token = quote(purchase_token, safe="")
        now = int(time.time())
        event_ms = int(notice.get("eventTimeMillis", 0) or 0)
        try:
            if product_type == "subs":
                purchase = _google_play_request("GET", f"/applications/{pkg}/purchases/subscriptionsv2/tokens/{token}")
                line_items = purchase.get("lineItems") or []
                # review P2：RTDN 無指定 product → 取 expiry 最晚（目前生效）那筆，productId+expiry 成對。
                product_id, expires_at = _pick_google_line_item(line_items)
                state = purchase.get("subscriptionState")
                active = state in {
                    "SUBSCRIPTION_STATE_ACTIVE",
                    "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
                    "SUBSCRIPTION_STATE_CANCELED",
                } and expires_at is not None and expires_at > now
                account_id = (purchase.get("externalAccountIdentifiers") or {}).get("obfuscatedExternalAccountId")
                is_test = "testPurchase" in purchase
            else:
                if not requested_product:
                    raise RuntimeError("one-time RTDN missing sku")
                product_id = requested_product
                product = quote(product_id, safe="")
                purchase = _google_play_request("GET", f"/applications/{pkg}/purchases/products/{product}/tokens/{token}")
                active = purchase.get("purchaseState") == 0 and notification_type != 2
                expires_at = None
                account_id = purchase.get("obfuscatedExternalAccountId")
                is_test = purchase.get("purchaseType") == 0
        except Exception as e:
            # A non-2xx response makes Pub/Sub retry; transient Google API failures should not lose lifecycle events.
            raise HTTPException(503, f"Google Play reconciliation unavailable: {e}")

        expected_account = _expected_app_account_token(row["user_id"])
        if not account_id or not hmac.compare_digest(account_id.lower(), expected_account):
            raise HTTPException(403, "Purchase account mismatch")
        mapped = GOOGLE_PLAY_PRODUCT_TO_TIER.get(product_id)
        if not mapped:
            return {"ok": True, "note": "unknown product"}
        # Schema B：算這筆購買的 state（entitlement 由投影算）。
        if product_type == "subs":
            if active:
                # CANCELED = 使用者已關自動續訂、付費期內仍有效（含 lifetime 升級後 server 自動取消）。
                new_state = "cancelled" if state == "SUBSCRIPTION_STATE_CANCELED" else "active"
            elif notification_type == 12:  # SUBSCRIPTION_REVOKED（退款收回）
                new_state = "refunded"
            else:
                new_state = "expired"
        else:
            # one-time：notificationType 2 = ONE_TIME_PRODUCT_CANCELED（退款/作廢）
            new_state = "active" if active else "refunded"
        source = "google_test" if is_test else "google"

        with get_db() as conn:
            current = conn.execute(
                "SELECT last_event_ts FROM aegistrans_purchases WHERE external_id=?",
                (external_id,),
            ).fetchone()
            if not current:
                return {"ok": True, "note": "purchase removed during reconciliation"}
            if event_ms and current["last_event_ts"] and event_ms < current["last_event_ts"]:
                return {"ok": True, "note": "stale notification ignored"}
            conn.execute(
                "UPDATE aegistrans_purchases SET tier=?, product_id=?, state=?, source=?, "
                "store_token=?, expires_at=?, last_event_ts=?, updated_at=? WHERE external_id=?",
                (mapped, product_id, new_state, source, purchase_token,
                 expires_at, event_ms or current["last_event_ts"], now, external_id),
            )
            ent = _recompute_entitlement(conn, row["user_id"])
        return {"ok": True, "state": new_state, "tier": ent.tier, "type": notification_type}

    @sub.post("/lemonsqueezy-webhook")
    async def lemonsqueezy_webhook(_request: Request):
        """LS webhook — 已改走 Apple IAP /verify（StoreKit 2）。LemonSqueezy 不再使用，回 503。"""
        raise HTTPException(503, "Not implemented (superseded by Apple IAP /verify)")

    return sub
