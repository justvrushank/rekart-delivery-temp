"""create shopify integration tables

Revision ID: 001_shopify_tables
Revises:
Create Date: 2026-06-11
"""

from alembic import op
import sqlalchemy as sa

revision = '001_shopify_tables'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'shopify_shops',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('shop_domain', sa.String(255), nullable=False),
        sa.Column('access_token', sa.String(255), nullable=False),
        sa.Column('rekart_merchant_id', sa.String(255), nullable=True),
        sa.Column('installed_at', sa.DateTime(), nullable=True),
        sa.Column('onboarding_complete', sa.Boolean(), nullable=True),
        # Generic sa.JSON maps to JSON on MySQL 5.7+/8.0 (and PostgreSQL); avoid
        # the postgresql-only JSON/JSONB dialect type.
        sa.Column('onboarding_answers', sa.JSON(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('shop_domain'),
    )
    op.create_index('ix_shopify_shops_shop_domain', 'shopify_shops', ['shop_domain'])

    op.create_table(
        'shopify_order_sync',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('shop_id', sa.Integer(), nullable=False),
        sa.Column('shopify_order_id', sa.String(100), nullable=False),
        sa.Column('rekart_delivery_job_id', sa.String(100), nullable=True),
        sa.Column('synced_at', sa.DateTime(), nullable=True),
        # sa.Enum renders as an inline MySQL ENUM column (no separate TYPE).
        sa.Column('status', sa.Enum('pending', 'synced', 'failed', name='syncstatus'), nullable=False),
        sa.ForeignKeyConstraint(['shop_id'], ['shopify_shops.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_order_sync_shopify_order_id', 'shopify_order_sync', ['shopify_order_id'])

    op.create_table(
        'shopify_customer_sync',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('shop_id', sa.Integer(), nullable=False),
        sa.Column('shopify_customer_id', sa.String(100), nullable=False),
        sa.Column('rekart_customer_id', sa.String(100), nullable=True),
        sa.Column('synced_at', sa.DateTime(), nullable=True),
        sa.Column('status', sa.Enum('pending', 'synced', 'failed', name='syncstatus'), nullable=False),
        sa.ForeignKeyConstraint(['shop_id'], ['shopify_shops.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_customer_sync_shopify_customer_id', 'shopify_customer_sync', ['shopify_customer_id'])

    op.create_table(
        'shopify_sync_logs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('shop_id', sa.Integer(), nullable=False),
        sa.Column('object_type', sa.Enum('order', 'customer', name='objecttype'), nullable=False),
        sa.Column('object_id', sa.String(100), nullable=False),
        sa.Column('event', sa.String(100), nullable=False),
        sa.Column('status', sa.String(50), nullable=False),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['shop_id'], ['shopify_shops.id']),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    # MySQL inlines ENUM types in the column definition (unlike PostgreSQL, which
    # creates a separate TYPE), so dropping the tables is sufficient — there is no
    # `DROP TYPE` to run.
    op.drop_table('shopify_sync_logs')
    op.drop_table('shopify_customer_sync')
    op.drop_table('shopify_order_sync')
    op.drop_table('shopify_shops')
