"""ai chat files catalog orders

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-02 19:34:47.779989
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0002'
down_revision: Union[str, None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Таблицы ИИ-сессий и чата, доп. списаний, настроек, доступа к файлам, каталога и парсера; поля заказа и ИИ-журнала
    op.create_table('app_settings',
    sa.Column('key', sa.String(length=60), nullable=False),
    sa.Column('value', sa.JSON(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('key')
    )
    op.create_table('suppliers',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('code', sa.String(length=40), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('order_method', sa.String(length=40), nullable=False),
    sa.Column('commission_bp', sa.Integer(), nullable=False),
    sa.Column('contacts', sa.JSON(), nullable=False),
    sa.Column('site_url', sa.String(length=300), nullable=True),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('code')
    )
    op.create_table('catalog_items',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('supplier_id', sa.Uuid(), nullable=False),
    sa.Column('sku', sa.String(length=80), nullable=False),
    sa.Column('type', sa.String(length=20), nullable=False),
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('core_key', sa.String(length=80), nullable=True),
    sa.Column('length_mm', sa.Double(), nullable=True),
    sa.Column('width_mm', sa.Double(), nullable=True),
    sa.Column('thickness_mm', sa.Double(), nullable=True),
    sa.Column('decor', sa.String(length=120), nullable=True),
    sa.Column('has_grain', sa.Boolean(), nullable=False),
    sa.Column('price', sa.Integer(), nullable=False),
    sa.Column('unit', sa.String(length=20), nullable=False),
    sa.Column('price_date', sa.DateTime(timezone=True), nullable=False),
    sa.Column('price_source', sa.String(length=120), nullable=False),
    sa.Column('available', sa.Boolean(), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('supplier_id', 'sku')
    )
    with op.batch_alter_table('catalog_items', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_catalog_items_core_key'), ['core_key'], unique=False)
        batch_op.create_index(batch_op.f('ix_catalog_items_supplier_id'), ['supplier_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_catalog_items_type'), ['type'], unique=False)

    op.create_table('parser_runs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('supplier_id', sa.Uuid(), nullable=False),
    sa.Column('source', sa.String(length=20), nullable=False),
    sa.Column('file_name', sa.String(length=300), nullable=True),
    sa.Column('full_snapshot', sa.Boolean(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('stats', sa.JSON(), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('parser_runs', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_parser_runs_supplier_id'), ['supplier_id'], unique=False)

    op.create_table('price_history',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('item_id', sa.Uuid(), nullable=False),
    sa.Column('old_price', sa.Integer(), nullable=True),
    sa.Column('new_price', sa.Integer(), nullable=False),
    sa.Column('source', sa.String(length=120), nullable=False),
    sa.Column('run_id', sa.Uuid(), nullable=True),
    sa.Column('changed_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['item_id'], ['catalog_items.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['run_id'], ['parser_runs.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('price_history', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_price_history_item_id'), ['item_id'], unique=False)

    op.create_table('raw_price_records',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('run_id', sa.Uuid(), nullable=False),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('sku', sa.String(length=80), nullable=True),
    sa.Column('name', sa.String(length=300), nullable=False),
    sa.Column('parsed', sa.JSON(), nullable=False),
    sa.Column('price', sa.Integer(), nullable=True),
    sa.Column('matched_item_id', sa.Uuid(), nullable=True),
    sa.Column('match_status', sa.String(length=20), nullable=False),
    sa.Column('old_price', sa.Integer(), nullable=True),
    sa.Column('change_pct', sa.Double(), nullable=True),
    sa.Column('review_status', sa.String(length=20), nullable=False),
    sa.Column('reviewed_by', sa.String(length=64), nullable=True),
    sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('error', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['matched_item_id'], ['catalog_items.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['run_id'], ['parser_runs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('raw_price_records', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_raw_price_records_run_id'), ['run_id'], unique=False)

    op.create_table('ai_sessions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('language', sa.String(length=2), nullable=False),
    sa.Column('data', sa.Text(), nullable=False),
    sa.Column('last_status', sa.String(length=20), nullable=True),
    sa.Column('last_result', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('project_id')
    )
    op.create_table('extra_charges',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('reason', sa.String(length=20), nullable=False),
    sa.Column('period', sa.String(length=7), nullable=False),
    sa.Column('source', sa.String(length=10), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('extra_charges', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_extra_charges_project_id'), ['project_id'], unique=False)
        batch_op.create_index('ix_extra_charges_workshop_period', ['workshop_id', 'period'], unique=False)

    op.create_table('file_access',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('basis', sa.String(length=20), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('granted_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('file_access', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_file_access_project_id'), ['project_id'], unique=False)

    op.create_table('chat_messages',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('author', sa.String(length=10), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('options', sa.JSON(), nullable=True),
    sa.Column('version_id', sa.Uuid(), nullable=True),
    sa.Column('price_delta', sa.JSON(), nullable=True),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['version_id'], ['model_versions.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('chat_messages', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_chat_messages_project_id'), ['project_id'], unique=False)

    op.create_table('file_downloads',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('version_id', sa.Uuid(), nullable=True),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('basis', sa.String(length=20), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['version_id'], ['model_versions.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('file_downloads', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_file_downloads_project_id'), ['project_id'], unique=False)

    with op.batch_alter_table('ai_requests', schema=None) as batch_op:
        batch_op.add_column(sa.Column('cache_write_tokens', sa.Integer(), server_default='0', nullable=False))
        batch_op.add_column(sa.Column('stop_reason', sa.String(length=30), nullable=True))
        batch_op.add_column(sa.Column('served_by', sa.String(length=80), nullable=True))

    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.add_column(sa.Column('handed_over_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('handed_over_by', sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column('status_changed_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('commission_status', sa.String(length=20), nullable=True))
        batch_op.add_column(sa.Column('notes', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('created_by', sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column('distance_km', sa.Double(), nullable=True))
        batch_op.add_column(sa.Column('composition', sa.JSON(), nullable=True))
        batch_op.create_foreign_key('fk_orders_created_by_users', 'users', ['created_by'], ['id'], ondelete='SET NULL')

    # ### end Alembic commands ###


def downgrade() -> None:
    # Таблицы ИИ-сессий и чата, доп. списаний, настроек, доступа к файлам, каталога и парсера; поля заказа и ИИ-журнала
    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.drop_constraint('fk_orders_created_by_users', type_='foreignkey')
        batch_op.drop_column('composition')
        batch_op.drop_column('distance_km')
        batch_op.drop_column('created_by')
        batch_op.drop_column('notes')
        batch_op.drop_column('commission_status')
        batch_op.drop_column('cancelled_at')
        batch_op.drop_column('status_changed_at')
        batch_op.drop_column('handed_over_by')
        batch_op.drop_column('handed_over_at')

    with op.batch_alter_table('ai_requests', schema=None) as batch_op:
        batch_op.drop_column('served_by')
        batch_op.drop_column('stop_reason')
        batch_op.drop_column('cache_write_tokens')

    with op.batch_alter_table('file_downloads', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_file_downloads_project_id'))

    op.drop_table('file_downloads')
    with op.batch_alter_table('chat_messages', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_chat_messages_project_id'))

    op.drop_table('chat_messages')
    with op.batch_alter_table('file_access', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_file_access_project_id'))

    op.drop_table('file_access')
    with op.batch_alter_table('extra_charges', schema=None) as batch_op:
        batch_op.drop_index('ix_extra_charges_workshop_period')
        batch_op.drop_index(batch_op.f('ix_extra_charges_project_id'))

    op.drop_table('extra_charges')
    op.drop_table('ai_sessions')
    with op.batch_alter_table('raw_price_records', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_raw_price_records_run_id'))

    op.drop_table('raw_price_records')
    with op.batch_alter_table('price_history', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_price_history_item_id'))

    op.drop_table('price_history')
    with op.batch_alter_table('parser_runs', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_parser_runs_supplier_id'))

    op.drop_table('parser_runs')
    with op.batch_alter_table('catalog_items', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_catalog_items_type'))
        batch_op.drop_index(batch_op.f('ix_catalog_items_supplier_id'))
        batch_op.drop_index(batch_op.f('ix_catalog_items_core_key'))

    op.drop_table('catalog_items')
    op.drop_table('suppliers')
    op.drop_table('app_settings')
    # ### end Alembic commands ###
