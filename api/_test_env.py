"""測試共用設定：在 import aegistrans_routes 之前呼叫 apply()。

測試走「自架」設定（AEGISTRANS_PROFILE=standalone，不吃官方部署預設值），所以私有版與公開匯出版
跑出來的結果一樣。IAP 用的商品代碼／套件名只是測試資料。
"""
import os

TEST_SETTINGS = {
    "AEGISTRANS_PROFILE": "standalone",
    "AEGISTRANS_APP_URL": "https://app.example.test",
    "AEGISTRANS_MAIL_FROM": "AegisTrans <noreply@example.test>",
    "AEGISTRANS_IAP_BUNDLE_ID": "com.aegisrd.aegistrans",
    "AEGISTRANS_IAP_APP_APPLE_ID": "1",
    "AEGISTRANS_IAP_PRODUCT_PREFIX": "com.aegisrd.aegistrans.pro",
    "AEGISTRANS_APPLE_ROOT_DIR": "/nonexistent-apple-roots",
    "AEGISTRANS_GOOGLE_PLAY_PACKAGE": "com.aegisrd.aegistrans",
    "AEGISTRANS_GOOGLE_SERVICE_ACCOUNT_FILE": "/nonexistent-google-sa.json",
}


def apply() -> None:
    for key, value in TEST_SETTINGS.items():
        os.environ.setdefault(key, value)
