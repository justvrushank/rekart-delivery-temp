"""
Shopify webhook handlers for the Rekart integration.

Group A — Shopify-delivered (orders/customers):
  Auth: Shopify HMAC (X-Shopify-Hmac-Sha256)
  Idempotency: deduplicate on X-Shopify-Webhook-Id

Group B — Remix-forwarded (GDPR + app lifecycle):
  Auth: X-API-Key shared secret
  Body: {shop, payload} wrapper (GDPR) or {shop} (app/uninstalled)
"""

import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from app.db.session import get_db
from app.models.shop import (
    Shop,
    OrderSync,
    CustomerSync,
    SyncLog,
    ObjectType,
    WebhookEvent,
)
from app.services.shopify_auth import verify_webhook_hmac, require_static_api_key
from app.tasks import sync_order, sync_customer

router = APIRouter(prefix="/webhooks/shopify", tags=["Webhooks"])
logger = logging.getLogger(__name__)


# ─── Group A helpers ─────────────────────────────────────────────────────────

async def _verify_shopify_hmac(
    request: Request,
    x_shopify_hmac_sha256: str | None = Header(default=None),
) -> bytes:
    raw = await request.body()
    if not verify_webhook_hmac(raw, x_shopify_hmac_sha256 or ""):
        raise HTTPException(status_code=401, detail="HMAC verification failed")
    return raw


async def _is_duplicate_webhook(
    webhook_id: str | None,
    topic: str,
    db: AsyncSession,
) -> bool:
    """Idempotency guard keyed on Shopify's ``X-Shopify-Webhook-Id``.

    Returns ``True`` if this id was already recorded (caller should no-op and
    return 200). For a new id it records the event and returns ``False``.

    Ordering contract that closes the dedup-vs-queue gap: callers enqueue the
    Celery sync *after* this records the event but *before* the request returns,
    and the row is only committed when the handler returns 200 (see
    ``get_db``). So if ``.delay()`` raises (broker down), the exception
    propagates, the transaction rolls back, the dedup row is NOT persisted, and
    Shopify's retry reprocesses cleanly. Once a task is durably enqueued,
    at-least-once delivery is the worker's responsibility (Celery retries +
    idempotent downstream ingest keyed on the Shopify object id).
    """
    if not webhook_id:
        return False
    existing = await db.scalar(
        select(WebhookEvent).where(WebhookEvent.webhook_id == webhook_id)
    )
    if existing:
        return True
    db.add(WebhookEvent(webhook_id=webhook_id, topic=topic))
    await db.flush()
    return False


# ─── Group A — orders ────────────────────────────────────────────────────────

@router.post("/orders/create")
async def orders_create(
    request: Request,
    body: bytes = Depends(_verify_shopify_hmac),
    x_shopify_shop_domain: str | None = Header(default=None),
    x_shopify_webhook_id: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    if await _is_duplicate_webhook(x_shopify_webhook_id, "orders/create", db):
        return {"received": True, "duplicate": True}
    order = json.loads(body)
    order_id = str(order.get("id"))
    shop_domain = x_shopify_shop_domain or ""
    logger.info(f"orders/create: shop={shop_domain} order_id={order_id}")
    sync_order.delay(shop_domain=shop_domain, shopify_order=order)
    return {"received": True, "order_id": order_id}


# ─── Group A — customers ─────────────────────────────────────────────────────

@router.post("/customers/create")
async def customers_create(
    request: Request,
    body: bytes = Depends(_verify_shopify_hmac),
    x_shopify_shop_domain: str | None = Header(default=None),
    x_shopify_webhook_id: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    if await _is_duplicate_webhook(x_shopify_webhook_id, "customers/create", db):
        return {"received": True, "duplicate": True}
    customer = json.loads(body)
    customer_id = str(customer.get("id"))
    shop_domain = x_shopify_shop_domain or ""
    logger.info(f"customers/create: shop={shop_domain} customer_id={customer_id}")
    sync_customer.delay(shop_domain=shop_domain, shopify_customer=customer, event="create")
    return {"received": True, "customer_id": customer_id}


@router.post("/customers/update")
async def customers_update(
    request: Request,
    body: bytes = Depends(_verify_shopify_hmac),
    x_shopify_shop_domain: str | None = Header(default=None),
    x_shopify_webhook_id: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    if await _is_duplicate_webhook(x_shopify_webhook_id, "customers/update", db):
        return {"received": True, "duplicate": True}
    customer = json.loads(body)
    customer_id = str(customer.get("id"))
    shop_domain = x_shopify_shop_domain or ""
    logger.info(f"customers/update: shop={shop_domain} customer_id={customer_id}")
    sync_customer.delay(shop_domain=shop_domain, shopify_customer=customer, event="update")
    return {"received": True, "customer_id": customer_id}


# ─── Group B — GDPR (X-API-Key, forwarded from Remix) ───────────────────

@router.post("/gdpr/customers_data_request", dependencies=[Depends(require_static_api_key)])
async def gdpr_customers_data_request(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Export everything we hold for a customer of a given shop.

    The backend stores sync metadata (Shopify object IDs + sync state), not the
    raw PII payloads, so the export is the set of CustomerSync rows for the
    customer, the OrderSync rows attributed to the customer, plus the SyncLog
    entries that reference them.
    """
    body = await request.json()
    shop_domain = body.get("shop", "")
    customer_id = body.get("payload", {}).get("customer", {}).get("id")
    customer_id_str = str(customer_id) if customer_id is not None else ""

    shop = await db.scalar(select(Shop).where(Shop.shop_domain == shop_domain))
    if not shop:
        logger.info(
            f"GDPR customers_data_request: unknown shop={shop_domain} "
            f"customer_id={customer_id_str} — nothing stored"
        )
        return {"status": "received", "data": {"customer_syncs": [], "sync_logs": []}}

    customer_syncs = (
        await db.scalars(
            select(CustomerSync).where(
                CustomerSync.shop_id == shop.id,
                CustomerSync.shopify_customer_id == customer_id_str,
            )
        )
    ).all()
    order_syncs = (
        await db.scalars(
            select(OrderSync).where(
                OrderSync.shop_id == shop.id,
                OrderSync.shopify_customer_id == customer_id_str,
            )
        )
    ).all()
    sync_logs = (
        await db.scalars(
            select(SyncLog).where(
                SyncLog.shop_id == shop.id,
                SyncLog.object_type == ObjectType.customer,
                SyncLog.object_id == customer_id_str,
            )
        )
    ).all()

    data = {
        "shop": shop_domain,
        "customer_id": customer_id_str,
        "customer_syncs": [
            {
                "shopify_customer_id": cs.shopify_customer_id,
                "rekart_customer_id": cs.rekart_customer_id,
                "status": cs.status.value,
                "synced_at": cs.synced_at.isoformat() if cs.synced_at else None,
            }
            for cs in customer_syncs
        ],
        "order_syncs": [
            {
                "shopify_order_id": os.shopify_order_id,
                "shopify_customer_id": os.shopify_customer_id,
                "rekart_delivery_job_id": os.rekart_delivery_job_id,
                "status": os.status.value,
                "synced_at": os.synced_at.isoformat() if os.synced_at else None,
            }
            for os in order_syncs
        ],
        "sync_logs": [
            {
                "object_id": sl.object_id,
                "event": sl.event,
                "status": sl.status,
                "created_at": sl.created_at.isoformat() if sl.created_at else None,
            }
            for sl in sync_logs
        ],
    }
    logger.info(
        f"GDPR customers_data_request: shop={shop_domain} customer_id={customer_id_str} "
        f"exported {len(data['customer_syncs'])} customer_syncs, "
        f"{len(data['order_syncs'])} order_syncs, "
        f"{len(data['sync_logs'])} sync_logs"
    )
    return {"status": "received", "data": data}


@router.post("/gdpr/customers_redact", dependencies=[Depends(require_static_api_key)])
async def gdpr_customers_redact(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Delete all data we hold for a customer of a given shop.

    Removes the customer's CustomerSync rows, the OrderSync rows attributed to
    the customer, and any customer-scoped SyncLog rows.
    """
    body = await request.json()
    shop_domain = body.get("shop", "")
    customer_id = body.get("payload", {}).get("customer", {}).get("id")
    customer_id_str = str(customer_id) if customer_id is not None else ""

    shop = await db.scalar(select(Shop).where(Shop.shop_domain == shop_domain))
    if not shop:
        logger.warning(
            f"GDPR customers_redact: unknown shop={shop_domain} "
            f"customer_id={customer_id_str} — nothing to delete"
        )
        return {
            "status": "received",
            "deleted": {"customer_syncs": 0, "order_syncs": 0, "sync_logs": 0},
        }

    cust_result = await db.execute(
        delete(CustomerSync).where(
            CustomerSync.shop_id == shop.id,
            CustomerSync.shopify_customer_id == customer_id_str,
        )
    )
    order_result = await db.execute(
        delete(OrderSync).where(
            OrderSync.shop_id == shop.id,
            OrderSync.shopify_customer_id == customer_id_str,
        )
    )
    log_result = await db.execute(
        delete(SyncLog).where(
            SyncLog.shop_id == shop.id,
            SyncLog.object_type == ObjectType.customer,
            SyncLog.object_id == customer_id_str,
        )
    )
    await db.commit()

    deleted = {
        "customer_syncs": cust_result.rowcount,
        "order_syncs": order_result.rowcount,
        "sync_logs": log_result.rowcount,
    }
    logger.warning(
        f"GDPR customers_redact: shop={shop_domain} customer_id={customer_id_str} "
        f"deleted {deleted['customer_syncs']} customer_syncs, "
        f"{deleted['order_syncs']} order_syncs, "
        f"{deleted['sync_logs']} sync_logs"
    )
    return {"status": "received", "deleted": deleted}


@router.post("/gdpr/shop_redact", dependencies=[Depends(require_static_api_key)])
async def gdpr_shop_redact(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Delete all data for a shop after the app is uninstalled (48h grace).

    Removes the shop's OrderSync, CustomerSync and SyncLog rows, then the Shop
    record itself. WebhookEvent rows are not shop-scoped in the current schema
    (they key only on the Shopify webhook id), so they cannot be filtered by
    shop and are left to the dedup table's own retention.
    """
    body = await request.json()
    shop_domain = body.get("shop", "")

    shop = await db.scalar(select(Shop).where(Shop.shop_domain == shop_domain))
    if not shop:
        logger.warning(
            f"GDPR shop_redact: unknown shop={shop_domain} — nothing to delete"
        )
        return {
            "status": "received",
            "deleted": {"order_syncs": 0, "customer_syncs": 0, "sync_logs": 0, "shop": 0},
        }

    order_result = await db.execute(
        delete(OrderSync).where(OrderSync.shop_id == shop.id)
    )
    cust_result = await db.execute(
        delete(CustomerSync).where(CustomerSync.shop_id == shop.id)
    )
    log_result = await db.execute(
        delete(SyncLog).where(SyncLog.shop_id == shop.id)
    )
    shop_result = await db.execute(
        delete(Shop).where(Shop.id == shop.id)
    )
    await db.commit()

    deleted = {
        "order_syncs": order_result.rowcount,
        "customer_syncs": cust_result.rowcount,
        "sync_logs": log_result.rowcount,
        "shop": shop_result.rowcount,
    }
    logger.warning(f"GDPR shop_redact: shop={shop_domain} deleted {deleted}")
    return {"status": "received", "deleted": deleted}


# ─── Group B — app lifecycle ──────────────────────────────────────────────────

@router.post("/app/uninstalled", dependencies=[Depends(require_static_api_key)])
async def app_uninstalled(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    body = await request.json()
    shop_domain = body.get("shop", "")
    logger.warning(f"app/uninstalled: marking {shop_domain} as inactive")

    result = await db.execute(select(Shop).where(Shop.shop_domain == shop_domain))
    shop = result.scalar_one_or_none()
    if shop:
        shop.is_active = False
        shop.access_token = ""

    return {"status": "ok"}
