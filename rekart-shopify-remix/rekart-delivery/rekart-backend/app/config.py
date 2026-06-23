from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    shopify_api_key: str
    shopify_api_secret: str
    shopify_scopes: str = "read_orders,read_customers,write_orders"
    shopify_app_url: str

    database_url: str
    redis_url: str = "redis://localhost:6379/0"

    rekart_backend_url: str
    rekart_internal_api_key: str
    rekart_static_api_key: str  # X-API-Key shared secret (Groups B & C)

    app_env: str = "development"

    class Config:
        env_file = ".env"
        # Ignore unrelated env vars instead of erroring. Deployment environments
        # carry many vars, and it lets a stale REKART_BACKEND_TOKEN coexist during
        # the rename to REKART_STATIC_API_KEY without breaking startup.
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
