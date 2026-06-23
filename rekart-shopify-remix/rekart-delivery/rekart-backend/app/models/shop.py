from datetime import datetime
from sqlalchemy import (
    String, Boolean, DateTime, Text, ForeignKey, JSON, Enum as SAEnum
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.session import Base
from app.util import utcnow
import enum


class SyncStatus(enum.Enum):
    pending = "pending"
    synced = "synced"
    failed = "failed"


class ObjectType(enum.Enum):
    order = "order"
    customer = "customer"


class Shop(Base):
    __tablename__ = "shopify_shops"

    id: Mapped[int] = mapped_column(primary_key=True)
    shop_domain: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    access_token: Mapped[str] = mapped_column(String(255), nullable=False)
    rekart_merchant_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    installed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    onboarding_complete: Mapped[bool] = mapped_column(Boolean, default=False)
    onboarding_answers: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    order_syncs: Mapped[list["OrderSync"]] = relationship(back_populates="shop")
    customer_syncs: Mapped[list["CustomerSync"]] = relationship(back_populates="shop")
    sync_logs: Mapped[list["SyncLog"]] = relationship(back_populates="shop")


class OrderSync(Base):
    __tablename__ = "shopify_order_sync"

    id: Mapped[int] = mapped_column(primary_key=True)
    shop_id: Mapped[int] = mapped_column(ForeignKey("shopify_shops.id"), nullable=False)
    shopify_order_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    shopify_customer_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    rekart_delivery_job_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[SyncStatus] = mapped_column(
        SAEnum(SyncStatus), default=SyncStatus.pending, nullable=False
    )

    shop: Mapped["Shop"] = relationship(back_populates="order_syncs")


class CustomerSync(Base):
    __tablename__ = "shopify_customer_sync"

    id: Mapped[int] = mapped_column(primary_key=True)
    shop_id: Mapped[int] = mapped_column(ForeignKey("shopify_shops.id"), nullable=False)
    shopify_customer_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    rekart_customer_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[SyncStatus] = mapped_column(
        SAEnum(SyncStatus), default=SyncStatus.pending, nullable=False
    )

    shop: Mapped["Shop"] = relationship(back_populates="customer_syncs")


class SyncLog(Base):
    __tablename__ = "shopify_sync_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    shop_id: Mapped[int] = mapped_column(ForeignKey("shopify_shops.id"), nullable=False)
    object_type: Mapped[ObjectType] = mapped_column(SAEnum(ObjectType), nullable=False)
    object_id: Mapped[str] = mapped_column(String(100), nullable=False)
    event: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(50), nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    shop: Mapped["Shop"] = relationship(back_populates="sync_logs")


class WebhookEvent(Base):
    """Tracks processed Shopify webhook IDs for idempotency dedup."""
    __tablename__ = "shopify_webhook_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    webhook_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    topic: Mapped[str] = mapped_column(String(100), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
