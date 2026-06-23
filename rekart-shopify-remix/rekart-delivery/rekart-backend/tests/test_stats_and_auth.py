"""Group C — dashboard stats (exact response shape) and the shops.py auth fix.

Contract: docs/fastapi-contract.md, Scheme 2 + Group C.
"""

from app.models.shop import Shop, OrderSync, CustomerSync, SyncLog, ObjectType, SyncStatus
from tests.conftest import REKART_TOKEN

DOMAIN = "rekart-dev.myshopify.com"
TOKEN_HEADERS = {"X-API-Key": REKART_TOKEN}


async def test_stats_unknown_shop_returns_zeros(client):
    resp = await client.get("/api/shops/unknown.myshopify.com/stats", headers=TOKEN_HEADERS)
    assert resp.status_code == 200
    assert resp.json() == {
        "ordersSynced": 0,
        "customersSynced": 0,
        "lastSyncedAt": None,
        "connected": False,
    }


async def test_stats_known_shop_counts_and_exact_shape(client, sessions):
    async with sessions() as s:
        shop = Shop(shop_domain=DOMAIN, access_token="t", is_active=True)
        s.add(shop)
        await s.commit()
        await s.refresh(shop)
        sid = shop.id
        s.add_all(
            [
                OrderSync(shop_id=sid, shopify_order_id="1", status=SyncStatus.synced),
                OrderSync(shop_id=sid, shopify_order_id="2", status=SyncStatus.synced),
                OrderSync(shop_id=sid, shopify_order_id="3", status=SyncStatus.pending),
                CustomerSync(shop_id=sid, shopify_customer_id="c1", status=SyncStatus.synced),
                CustomerSync(shop_id=sid, shopify_customer_id="c2", status=SyncStatus.synced),
                SyncLog(shop_id=sid, object_type=ObjectType.order, object_id="1", event="create", status="ok"),
            ]
        )
        await s.commit()

    resp = await client.get(f"/api/shops/{DOMAIN}/stats", headers=TOKEN_HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    # Exact key set required by the dashboard loader.
    assert set(data.keys()) == {"ordersSynced", "customersSynced", "lastSyncedAt", "connected"}
    assert data["ordersSynced"] == 2  # only "synced", not the pending one
    assert data["customersSynced"] == 2
    assert data["connected"] is True
    assert data["lastSyncedAt"] is not None and data["lastSyncedAt"].endswith("Z")


async def test_stats_requires_token(client):
    resp = await client.get(f"/api/shops/{DOMAIN}/stats")
    assert resp.status_code == 401


# --- Security fix: shops.py endpoints that used to be public now require the token ---


async def test_sync_status_requires_token(client):
    assert (await client.get("/api/shops/1/sync-status")).status_code == 401


async def test_backfill_requires_token(client):
    assert (await client.post("/api/shops/1/backfill")).status_code == 401


async def test_delete_shop_requires_token(client):
    assert (await client.delete("/api/shops/1")).status_code == 401


async def test_onboarding_requires_token(client):
    assert (await client.post("/api/shops/1/onboarding", json={})).status_code == 401
