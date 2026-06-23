"""Shared test fixtures for the Rekart FastAPI backend contract tests.

Hermetic by design: an in-memory SQLite database (StaticPool so a single
connection is shared across sessions) and mocked Celery `.delay` calls, so the
suite needs neither Postgres nor Redis. The contract under test lives in
`rekart-shopify-remix/rekart-delivery/docs/fastapi-contract.md`.
"""

import os

# Settings are read + cached at import time, so test config must be in the
# environment BEFORE any `app.*` module is imported. os.environ takes priority
# over the .env file in pydantic-settings, so these win.
os.environ.update(
    {
        "SHOPIFY_API_KEY": "test_api_key",
        "SHOPIFY_API_SECRET": "test_api_secret",
        "SHOPIFY_APP_URL": "https://app.test",
        # aiomysql URL — never connected to (get_db is overridden); only present so
        # the module-level engine in app.db.session constructs without error.
        "DATABASE_URL": "mysql+aiomysql://u:p@localhost:3306/unused_in_tests",
        "REDIS_URL": "redis://localhost:6379/0",
        "REKART_BACKEND_URL": "https://rekart.test",
        "REKART_INTERNAL_API_KEY": "test_internal_key",
        "REKART_STATIC_API_KEY": "test_rekart_token",
        "APP_ENV": "test",
    }
)

import base64
import hashlib
import hmac
import unittest.mock as mock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.main import app
from app.db.session import Base, get_db

# Use `from ... import ... as ...` (NOT `import app.models.shop`): the latter
# rebinds the top-level name `app` to the package, clobbering the FastAPI
# instance imported above.
from app.models import shop as _models  # noqa: F401 — registers tables on Base.metadata
from app.routers import webhooks as webhooks_router

# Must match SHOPIFY_API_SECRET above (bytes) for HMAC signing in tests.
_SECRET = b"test_api_secret"
REKART_TOKEN = "test_rekart_token"


def shopify_hmac(body: bytes) -> str:
    """Base64 HMAC-SHA256 of the raw body, exactly as Shopify signs webhooks."""
    return base64.b64encode(hmac.new(_SECRET, body, hashlib.sha256).digest()).decode()


@pytest_asyncio.fixture
async def sessions():
    """A sessionmaker bound to a fresh in-memory SQLite DB with tables created."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield maker
    await engine.dispose()


@pytest_asyncio.fixture
async def db(sessions):
    """A session for arranging and asserting DB state directly in tests."""
    async with sessions() as session:
        yield session
        await session.commit()


@pytest.fixture
def tasks(monkeypatch):
    """Replace the Celery task objects with mocks so `.delay()` is a no-op."""
    fake_order = mock.MagicMock(name="sync_order")
    fake_customer = mock.MagicMock(name="sync_customer")
    monkeypatch.setattr(webhooks_router, "sync_order", fake_order)
    monkeypatch.setattr(webhooks_router, "sync_customer", fake_customer)
    return mock.Mock(sync_order=fake_order, sync_customer=fake_customer)


@pytest_asyncio.fixture
async def client(sessions, tasks):
    """AsyncClient wired to the app with get_db overridden onto the test DB."""

    async def override_get_db():
        async with sessions() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
            finally:
                await session.close()

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()
