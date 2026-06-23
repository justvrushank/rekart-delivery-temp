"""
Celery background tasks for syncing Shopify data into the Rekart backend.

These are called from webhook handlers and run asynchronously so we
can return 200 to Shopify within 5 seconds regardless of Rekart's response time.
"""

from celery import Celery
import httpx
import asyncio
import logging
from app.config import get_settings
from app.util import utcnow

settings = get_settings()
logger = logging.getLogger(__name__)

celery_app = Celery(
    "rekart_shopify",
    broker=settings.redis_url,
    backend=settings.redis_url,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,           # Re-queue on worker crash
    task_reject_on_worker_lost=True,
    task_max_retries=5,
    task_default_retry_delay=30,   # 30 seconds between retries
)


@celery_app.task(bind=True, max_retries=5, default_retry_delay=30)
def sync_order(self, shop_domain: str, shopify_order: dict):
    """
    Receive a Shopify order and create a delivery job in Rekart.
    Idempotent: Rekart /orders/ingest should deduplicate by shopify_order_id.
    """
    try:
        order_id = str(shopify_order.get("id"))
        logger.info(f"sync_order: shop={shop_domain} order_id={order_id}")

        payload = {
            "shopify_order_id": order_id,
            "shop_domain": shop_domain,
            "order_number": shopify_order.get("order_number"),
            "customer": shopify_order.get("customer", {}),
            "line_items": shopify_order.get("line_items", []),
            "shipping_address": shopify_order.get("shipping_address", {}),
            "total_price": shopify_order.get("total_price"),
            "currency": shopify_order.get("currency"),
            "created_at": shopify_order.get("created_at"),
        }

        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                f"{settings.rekart_backend_url}/rekart/orders/ingest",
                json=payload,
                headers={"X-Internal-Key": settings.rekart_internal_api_key},
            )
            resp.raise_for_status()

        rekart_job_id = resp.json().get("delivery_job_id")
        logger.info(f"sync_order success: order_id={order_id} rekart_job_id={rekart_job_id}")
        return {"status": "synced", "rekart_job_id": rekart_job_id}

    except httpx.HTTPStatusError as exc:
        logger.error(f"sync_order HTTP error: {exc.response.status_code} — {exc.response.text}")
        raise self.retry(exc=exc)
    except Exception as exc:
        logger.error(f"sync_order error: {exc}")
        raise self.retry(exc=exc)


@celery_app.task(bind=True, max_retries=5, default_retry_delay=30)
def sync_customer(self, shop_domain: str, shopify_customer: dict, event: str = "create"):
    """
    Upsert a Shopify customer into Rekart.
    Called on both customers/create and customers/update webhooks.
    """
    try:
        customer_id = str(shopify_customer.get("id"))
        logger.info(f"sync_customer: shop={shop_domain} customer_id={customer_id} event={event}")

        payload = {
            "shopify_customer_id": customer_id,
            "shop_domain": shop_domain,
            "email": shopify_customer.get("email"),
            "first_name": shopify_customer.get("first_name"),
            "last_name": shopify_customer.get("last_name"),
            "phone": shopify_customer.get("phone"),
            "default_address": shopify_customer.get("default_address", {}),
            "event": event,
        }

        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                f"{settings.rekart_backend_url}/rekart/customers/upsert",
                json=payload,
                headers={"X-Internal-Key": settings.rekart_internal_api_key},
            )
            resp.raise_for_status()

        rekart_customer_id = resp.json().get("rekart_customer_id")
        logger.info(f"sync_customer success: customer_id={customer_id} rekart_id={rekart_customer_id}")
        return {"status": "synced", "rekart_customer_id": rekart_customer_id}

    except httpx.HTTPStatusError as exc:
        logger.error(f"sync_customer HTTP error: {exc.response.status_code} — {exc.response.text}")
        raise self.retry(exc=exc)
    except Exception as exc:
        logger.error(f"sync_customer error: {exc}")
        raise self.retry(exc=exc)


@celery_app.task
def backfill_shop(shop_domain: str, access_token: str):
    """
    Import last 90 days of orders + all customers for a newly connected store.
    Called once during onboarding.
    """
    logger.info(f"backfill_shop: starting backfill for {shop_domain}")

    with httpx.Client(timeout=30.0) as client:
        # Fetch customers
        customers_url = f"https://{shop_domain}/admin/api/2024-01/customers.json?limit=250"
        headers = {"X-Shopify-Access-Token": access_token}

        while customers_url:
            resp = client.get(customers_url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            for customer in data.get("customers", []):
                sync_customer.delay(shop_domain=shop_domain, shopify_customer=customer, event="backfill")
            # Handle pagination
            link_header = resp.headers.get("link", "")
            customers_url = _parse_next_link(link_header)

        # Fetch last 90 days of orders
        from datetime import timedelta
        since = (utcnow() - timedelta(days=90)).isoformat() + "Z"
        orders_url = f"https://{shop_domain}/admin/api/2024-01/orders.json?status=any&limit=250&created_at_min={since}"

        while orders_url:
            resp = client.get(orders_url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            for order in data.get("orders", []):
                sync_order.delay(shop_domain=shop_domain, shopify_order=order)
            link_header = resp.headers.get("link", "")
            orders_url = _parse_next_link(link_header)

    logger.info(f"backfill_shop: dispatched all backfill tasks for {shop_domain}")


def _parse_next_link(link_header: str) -> str | None:
    """Parse Shopify pagination Link header to get next page URL."""
    if not link_header:
        return None
    for part in link_header.split(","):
        if 'rel="next"' in part:
            url = part.split(";")[0].strip().strip("<>")
            return url
    return None
