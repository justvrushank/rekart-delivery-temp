import hmac
import hashlib
import base64
from fastapi import Header, HTTPException
from app.config import get_settings

settings = get_settings()


def verify_webhook_hmac(data: bytes, hmac_header: str) -> bool:
    """
    Verify Shopify webhook HMAC signature.
    Must be called on raw request bytes before any parsing.
    """
    digest = hmac.new(
        settings.shopify_api_secret.encode("utf-8"),
        data,
        hashlib.sha256,
    ).digest()
    computed = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(computed, hmac_header)


async def require_static_api_key(
    x_api_key: str | None = Header(default=None),
) -> None:
    """FastAPI dependency: reject requests without a valid X-API-Key header."""
    key = settings.rekart_static_api_key
    if not x_api_key or not hmac.compare_digest(x_api_key, key):
        raise HTTPException(status_code=401, detail="Invalid API key")
