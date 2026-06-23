"""Group A — Shopify-delivered data webhooks: HMAC auth + idempotency dedup.

Contract: docs/fastapi-contract.md, Scheme 1 + Group A.
"""

import json

from tests.conftest import shopify_hmac

ORDER_BODY = {
    "id": 5544332211000,
    "order_number": 1001,
    "currency": "INR",
    "total_price": "499.00",
    "customer": {"id": 6677889900, "first_name": "Asha"},
    "line_items": [{"id": 1, "title": "Cold Brew", "quantity": 2}],
}

CUSTOMER_BODY = {
    "id": 6677889900,
    "first_name": "Asha",
    "last_name": "Rao",
    "email": "buyer@example.com",
}


def _raw(body: dict) -> bytes:
    return json.dumps(body).encode()


def _headers(raw: bytes, webhook_id: str) -> dict:
    return {
        "X-Shopify-Hmac-Sha256": shopify_hmac(raw),
        "X-Shopify-Shop-Domain": "rekart-dev.myshopify.com",
        "X-Shopify-Webhook-Id": webhook_id,
        "Content-Type": "application/json",
    }


async def test_orders_create_valid_hmac_enqueues(client, tasks):
    raw = _raw(ORDER_BODY)
    resp = await client.post("/webhooks/shopify/orders/create", content=raw, headers=_headers(raw, "wh-1"))
    assert resp.status_code == 200
    data = resp.json()
    assert data["received"] is True
    assert data["order_id"] == "5544332211000"
    tasks.sync_order.delay.assert_called_once()


async def test_orders_create_bad_hmac_rejected(client, tasks):
    raw = _raw(ORDER_BODY)
    resp = await client.post(
        "/webhooks/shopify/orders/create",
        content=raw,
        headers={"X-Shopify-Hmac-Sha256": "bm90LXZhbGlk", "X-Shopify-Webhook-Id": "wh-x"},
    )
    assert resp.status_code == 401
    tasks.sync_order.delay.assert_not_called()


async def test_orders_create_missing_hmac_rejected(client, tasks):
    raw = _raw(ORDER_BODY)
    resp = await client.post("/webhooks/shopify/orders/create", content=raw)
    assert resp.status_code == 401
    tasks.sync_order.delay.assert_not_called()


async def test_orders_create_dedup_on_webhook_id(client, tasks):
    raw = _raw(ORDER_BODY)
    headers = _headers(raw, "dup-1")
    first = await client.post("/webhooks/shopify/orders/create", content=raw, headers=headers)
    second = await client.post("/webhooks/shopify/orders/create", content=raw, headers=headers)
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json().get("duplicate") is True
    # The duplicate must NOT be re-enqueued.
    tasks.sync_order.delay.assert_called_once()


async def test_customers_create_valid_hmac(client, tasks):
    raw = _raw(CUSTOMER_BODY)
    resp = await client.post("/webhooks/shopify/customers/create", content=raw, headers=_headers(raw, "wh-c1"))
    assert resp.status_code == 200
    assert resp.json()["customer_id"] == "6677889900"
    tasks.sync_customer.delay.assert_called_once()


async def test_customers_update_valid_hmac(client, tasks):
    raw = _raw(CUSTOMER_BODY)
    resp = await client.post("/webhooks/shopify/customers/update", content=raw, headers=_headers(raw, "wh-c2"))
    assert resp.status_code == 200
    assert resp.json()["customer_id"] == "6677889900"
    tasks.sync_customer.delay.assert_called_once()
