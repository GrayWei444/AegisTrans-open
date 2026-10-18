"""Standalone AegisTrans API for self-hosting.

Run:  uvicorn app:create_app --factory --host 0.0.0.0 --port 8000   (from the api/ directory)

Every setting comes from environment variables (see api/.env.example). Nothing falls
back to the official service: AEGISTRANS_PROFILE is forced to "standalone" before the
router module is imported. The official deployment keeps mounting the same routers
inside its existing API process instead of using this file.
"""
import os
from urllib.parse import urlsplit

os.environ["AEGISTRANS_PROFILE"] = "standalone"

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

REQUIRED = (
    "AEGISTRANS_JWT_SECRET",       # signs session tokens
    "AEGIS_MQTT_JWT_SECRET",       # signs MQTT tokens; the broker verifies with the same secret
    "AEGIS_DB_PATH",               # SQLite file (created on first start)
    "AEGISTRANS_APP_URL",          # public URL of the web app; e-mail links point here
    "AEGISTRANS_MAIL_FROM",        # e.g. "AegisTrans <noreply@example.com>"
    "AEGISTRANS_PUBLIC_MQTT_URL",  # wss:// URL clients use for the broker
)
MIN_SECRET_LENGTH = 32

# Origins that may call the API from a browser / app shell besides AEGISTRANS_APP_URL.
# Android WebView = https://localhost, iOS = capacitor://localhost, Electron = capacitor-electron://-
APP_SHELL_ORIGINS = ["https://localhost", "capacitor://localhost", "capacitor-electron://-"]


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""


def _check_config() -> None:
    missing = [name for name in REQUIRED if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Missing required settings (see api/.env.example): " + ", ".join(missing))
    for name in ("AEGISTRANS_JWT_SECRET", "AEGIS_MQTT_JWT_SECRET"):
        if len(os.environ[name]) < MIN_SECRET_LENGTH:
            raise RuntimeError(f"{name} must be at least {MIN_SECRET_LENGTH} characters (use: openssl rand -hex 32)")
    if os.environ["AEGISTRANS_JWT_SECRET"] == os.environ["AEGIS_MQTT_JWT_SECRET"]:
        raise RuntimeError("AEGISTRANS_JWT_SECRET and AEGIS_MQTT_JWT_SECRET must be different")
    if os.environ.get("AEGISTRANS_DEV_MODE") == "1":
        print("[aegistrans] WARNING: AEGISTRANS_DEV_MODE=1 lets admin e-mails change tiers; never enable in production", flush=True)


def _allowed_origins() -> list:
    extra = [o.strip() for o in os.environ.get("AEGISTRANS_CORS_ORIGINS", "").split(",") if o.strip()]
    origins = [_origin(os.environ["AEGISTRANS_APP_URL"])] + APP_SHELL_ORIGINS + extra
    return [o for i, o in enumerate(origins) if o and o not in origins[:i]]


def create_app() -> FastAPI:
    _check_config()
    from aegistrans_routes import create_aegistrans_router, create_aegistrans_subscription_router

    app = FastAPI(title="AegisTrans API", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_allowed_origins(),
        allow_credentials=False,  # bearer tokens only, no cookies
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.include_router(create_aegistrans_router())
    app.include_router(create_aegistrans_subscription_router())

    @app.get("/health")
    def health():
        return {"ok": True, "service": "aegistrans-api"}

    return app
