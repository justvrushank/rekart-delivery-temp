"""
Shop management endpoints.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.db.session import get_db
from app.models.shop import Shop, OrderSync, CustomerSync, SyncLog, SyncStatus
from app.services.shopify_auth import require_static_api_key
from app.tasks import backfill_shop

# Every shop endpoint requires the shared X-API-Key (contract Scheme 2).
# Applied at the router level so no route can be accidentally left unauthenticated
# — previously only /stats was guarded while sync-status, backfill, onboarding and
# DELETE were publicly callable (DELETE wiped all of a shop's data).
router = APIRouter(
    prefix="/api/shops",
    tags=["Shops"],
    dependencies=[Depends(require_static_api_key)],
)


@router.get("/{shop}/stats")
async def get_shop_stats(shop: str, db: AsyncSession = Depends(get_db)):
    """
    Dashboard sync stats. Exact response shape is required by the Remix dashboard.
    Returns zeros with connected=false for unknown shops (not 404) so the dashboard
    degrades gracefully on first install.
    """
    result = await db.execute(select(Shop).where(Shop.shop_domain == shop))
    db_shop = result.scalar_one_or_none()

    if not db_shop:
        return {"ordersSynced": 0, "customersSynced": 0, "lastSyncedAt": None, "connected": False}

    orders_synced = await db.scalar(
        select(func.count()).where(
            OrderSync.shop_id == db_shop.id, OrderSync.status == SyncStatus.synced
        )
    ) or 0

    customers_synced = await db.scalar(
        select(func.count()).where(
            CustomerSync.shop_id == db_shop.id, CustomerSync.status == SyncStatus.synced
        )
    ) or 0

    last_log = await db.scalar(
        select(SyncLog).where(SyncLog.shop_id == db_shop.id).order_by(SyncLog.created_at.desc())
    )
    last_synced_at = last_log.created_at.isoformat() + "Z" if last_log else None

    return {
        "ordersSynced": orders_synced,
        "customersSynced": customers_synced,
        "lastSyncedAt": last_synced_at,
        "connected": db_shop.is_active,
    }


@router.get("/{shop_id}/sync-status")
async def get_sync_status(shop_id: int, db: AsyncSession = Depends(get_db)):
    """Return sync health summary for the embedded dashboard."""
    result = await db.execute(select(Shop).where(Shop.id == shop_id, Shop.is_active == True))
    shop = result.scalar_one_or_none()
    if not shop:
        raise HTTPException(status_code=404, detail="Shop not found")

    # Order sync stats
    order_total = await db.scalar(select(func.count()).where(OrderSync.shop_id == shop_id))
    order_synced = await db.scalar(
        select(func.count()).where(OrderSync.shop_id == shop_id, OrderSync.status == SyncStatus.synced)
    )
    order_failed = await db.scalar(
        select(func.count()).where(OrderSync.shop_id == shop_id, OrderSync.status == SyncStatus.failed)
    )

    # Customer sync stats
    customer_total = await db.scalar(select(func.count()).where(CustomerSync.shop_id == shop_id))
    customer_synced = await db.scalar(
        select(func.count()).where(CustomerSync.shop_id == shop_id, CustomerSync.status == SyncStatus.synced)
    )

    # Last sync log entry
    last_log = await db.scalar(
        select(SyncLog).where(SyncLog.shop_id == shop_id).order_by(SyncLog.created_at.desc())
    )

    return {
        "shop_id": shop_id,
        "shop_domain": shop.shop_domain,
        "is_active": shop.is_active,
        "onboarding_complete": shop.onboarding_complete,
        "orders": {
            "total": order_total,
            "synced": order_synced,
            "failed": order_failed,
        },
        "customers": {
            "total": customer_total,
            "synced": customer_synced,
        },
        "last_sync_at": last_log.created_at.isoformat() if last_log else None,
    }


@router.post("/{shop_id}/backfill")
async def trigger_backfill(shop_id: int, db: AsyncSession = Depends(get_db)):
    """Trigger historical import for a newly connected shop."""
    result = await db.execute(select(Shop).where(Shop.id == shop_id, Shop.is_active == True))
    shop = result.scalar_one_or_none()
    if not shop:
        raise HTTPException(status_code=404, detail="Shop not found")

    backfill_shop.delay(shop_domain=shop.shop_domain, access_token=shop.access_token)
    return {"status": "backfill_queued", "shop_domain": shop.shop_domain}


@router.delete("/{shop_id}")
async def delete_shop_data(shop_id: int, db: AsyncSession = Depends(get_db)):
    """
    Full data removal — called on uninstall or GDPR shop_redact.
    Deletes all sync records for the shop.
    """
    result = await db.execute(select(Shop).where(Shop.id == shop_id))
    shop = result.scalar_one_or_none()
    if not shop:
        raise HTTPException(status_code=404, detail="Shop not found")

    # Delete child records first
    await db.execute(SyncLog.__table__.delete().where(SyncLog.shop_id == shop_id))
    await db.execute(OrderSync.__table__.delete().where(OrderSync.shop_id == shop_id))
    await db.execute(CustomerSync.__table__.delete().where(CustomerSync.shop_id == shop_id))
    await db.delete(shop)

    return {"status": "deleted", "shop_id": shop_id}


@router.post("/{shop_id}/onboarding")
async def save_onboarding(shop_id: int, answers: dict, db: AsyncSession = Depends(get_db)):
    """Save onboarding qualification answers for sales routing."""
    result = await db.execute(select(Shop).where(Shop.id == shop_id, Shop.is_active == True))
    shop = result.scalar_one_or_none()
    if not shop:
        raise HTTPException(status_code=404, detail="Shop not found")

    shop.onboarding_answers = answers
    shop.onboarding_complete = True
    return {"status": "saved"}
