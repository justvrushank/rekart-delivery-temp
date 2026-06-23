"""Group B — Remix-forwarded events: X-API-Key auth, GDPR + app lifecycle.

Contract: docs/fastapi-contract.md, Scheme 2 + Group B.
"""

from app.models.shop import Shop, OrderSync, CustomerSync, SyncLog, ObjectType, SyncStatus
from tests.conftest import REKART_TOKEN

DOMAIN = "rekart-dev.myshopify.com"
TOKEN_HEADERS = {"X-API-Key": REKART_TOKEN}


async def _make_shop(sessions, domain=DOMAIN, active=True) -> int:
    async with sessions() as s:
        shop = Shop(shop_domain=domain, access_token="tok", is_active=active)
        s.add(shop)
        await s.commit()
        await s.refresh(shop)
        return shop.id


async def test_app_uninstalled_marks_inactive(client, sessions):
    shop_id = await _make_shop(sessions)
    resp = await client.post(
        "/webhooks/shopify/app/uninstalled",
        json={"shop": DOMAIN},
        headers=TOKEN_HEADERS,
    )
    assert resp.status_code == 200
    async with sessions() as s:
        shop = await s.get(Shop, shop_id)
        assert shop.is_active is False
        assert shop.access_token == ""


async def test_app_uninstalled_bad_token_rejected(client):
    resp = await client.post(
        "/webhooks/shopify/app/uninstalled",
        json={"shop": DOMAIN},
        headers={"X-API-Key": "wrong-token"},
    )
    assert resp.status_code == 401


async def test_app_uninstalled_missing_token_rejected(client):
    resp = await client.post("/webhooks/shopify/app/uninstalled", json={"shop": DOMAIN})
    assert resp.status_code == 401


async def test_gdpr_customers_redact_deletes_customer_data(client, sessions):
    shop_id = await _make_shop(sessions)
    async with sessions() as s:
        s.add(CustomerSync(shop_id=shop_id, shopify_customer_id="6677889900", status=SyncStatus.synced))
        s.add(OrderSync(shop_id=shop_id, shopify_order_id="1", shopify_customer_id="6677889900", status=SyncStatus.synced))
        s.add(SyncLog(shop_id=shop_id, object_type=ObjectType.customer, object_id="6677889900", event="create", status="ok"))
        await s.commit()

    resp = await client.post(
        "/webhooks/shopify/gdpr/customers_redact",
        json={"shop": DOMAIN, "payload": {"customer": {"id": 6677889900}}},
        headers=TOKEN_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"] == {"customer_syncs": 1, "order_syncs": 1, "sync_logs": 1}


async def test_gdpr_shop_redact_purges_shop(client, sessions):
    shop_id = await _make_shop(sessions)
    async with sessions() as s:
        s.add(OrderSync(shop_id=shop_id, shopify_order_id="1", status=SyncStatus.synced))
        await s.commit()

    resp = await client.post(
        "/webhooks/shopify/gdpr/shop_redact",
        json={"shop": DOMAIN, "payload": {"shop_domain": DOMAIN}},
        headers=TOKEN_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["deleted"]["shop"] == 1
    async with sessions() as s:
        assert await s.get(Shop, shop_id) is None


async def test_gdpr_data_request_unknown_shop_returns_empty(client):
    resp = await client.post(
        "/webhooks/shopify/gdpr/customers_data_request",
        json={"shop": "nope.myshopify.com", "payload": {"customer": {"id": 1}}},
        headers=TOKEN_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["customer_syncs"] == []


async def test_gdpr_missing_token_rejected(client):
    resp = await client.post(
        "/webhooks/shopify/gdpr/customers_redact",
        json={"shop": DOMAIN, "payload": {}},
    )
    assert resp.status_code == 401
