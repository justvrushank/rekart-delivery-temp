"""
Rekart Shopify App — FastAPI Backend
Handles OAuth, webhooks, and sync coordination for the Shopify integration.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from app.db.session import engine
from app.models.shop import Base, WebhookEvent  # noqa: F401 — needed for metadata.create_all
# OAuth is owned entirely by the Remix app (authenticate.admin / auth.$ routes).
# The backend must not run a parallel OAuth flow, so no oauth router here.
from app.routers import webhooks, shops
from app.config import get_settings

settings = get_settings()
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Convenience for fresh/local databases only: create any missing tables on
    # startup. Alembic migrations (alembic.ini + migrations/) are the canonical
    # path for schema changes — create_all does NOT alter existing tables, so
    # run `alembic upgrade head` to apply column/index changes to a live DB.
    # Gated to development so it can't silently mask migration drift in prod.
    if settings.app_env == "development":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(
    title="Rekart Shopify App — Backend",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.app_env == "development" else None,
)

# CORS — restrict in production to your Shopify app domain
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.app_env == "development" else [settings.shopify_app_url],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(webhooks.router)
app.include_router(shops.router)


@app.get("/health")
async def health():
    return {"status": "ok", "env": settings.app_env}
