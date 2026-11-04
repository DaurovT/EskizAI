"""initial schema

Revision ID: 0001
Revises: 
Create Date: 2026-11-02
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('auth_codes',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('phone', sa.String(length=20), nullable=False),
    sa.Column('code_hash', sa.String(length=64), nullable=False),
    sa.Column('channel', sa.String(length=10), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('attempts', sa.Integer(), nullable=False),
    sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('auth_codes', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_auth_codes_phone'), ['phone'], unique=False)

    op.create_table('workshops',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('city', sa.String(length=100), nullable=False),
    sa.Column('logo_url', sa.String(length=500), nullable=True),
    sa.Column('phone', sa.String(length=20), nullable=True),
    sa.Column('labor_mode', sa.String(length=10), nullable=False),
    sa.Column('labor_percent', sa.Integer(), nullable=False),
    sa.Column('labor_fixed', sa.Integer(), nullable=False),
    sa.Column('markup_body', sa.Integer(), nullable=False),
    sa.Column('markup_fronts', sa.Integer(), nullable=False),
    sa.Column('markup_hardware', sa.Integer(), nullable=False),
    sa.Column('markup_services', sa.Integer(), nullable=False),
    sa.Column('default_estimate_view', sa.String(length=10), nullable=False),
    sa.Column('employee_estimate_views', sa.JSON(), nullable=False),
    sa.Column('plan', sa.String(length=10), nullable=False),
    sa.Column('pack_projects_left', sa.Integer(), nullable=False),
    sa.Column('pro_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('blocked', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('action_log',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('actor_type', sa.String(length=20), nullable=False),
    sa.Column('actor_id', sa.String(length=64), nullable=True),
    sa.Column('workshop_id', sa.Uuid(), nullable=True),
    sa.Column('entity', sa.String(length=40), nullable=False),
    sa.Column('entity_id', sa.String(length=64), nullable=True),
    sa.Column('action', sa.String(length=40), nullable=False),
    sa.Column('before', sa.JSON(), nullable=True),
    sa.Column('after', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('action_log', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_action_log_workshop_id'), ['workshop_id'], unique=False)

    op.create_table('clients',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('phone', sa.String(length=20), nullable=True),
    sa.Column('address', sa.String(length=500), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('clients', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_clients_workshop_id'), ['workshop_id'], unique=False)

    op.create_table('users',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('phone', sa.String(length=20), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('role', sa.String(length=10), nullable=False),
    sa.Column('language', sa.String(length=2), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('phone')
    )
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_users_workshop_id'), ['workshop_id'], unique=False)

    op.create_table('devices',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('device_id', sa.String(length=200), nullable=False),
    sa.Column('platform', sa.String(length=20), nullable=True),
    sa.Column('push_token', sa.String(length=500), nullable=True),
    sa.Column('first_seen_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'device_id')
    )
    with op.batch_alter_table('devices', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_devices_user_id'), ['user_id'], unique=False)

    op.create_table('projects',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('client_id', sa.Uuid(), nullable=True),
    sa.Column('author_id', sa.Uuid(), nullable=True),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('product_type', sa.String(length=40), nullable=True),
    sa.Column('source_text', sa.Text(), nullable=True),
    sa.Column('is_example', sa.Boolean(), nullable=False),
    sa.Column('charged_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('charge_period', sa.String(length=7), nullable=True),
    sa.Column('charge_source', sa.String(length=10), nullable=True),
    sa.Column('returned_to_limit_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('current_version_id', sa.Uuid(), nullable=True),
    sa.Column('frozen_version_id', sa.Uuid(), nullable=True),
    sa.Column('client_agreed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('contract_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('delivered_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('materials_self_bought', sa.Boolean(), nullable=False),
    sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('cancelled_from', sa.String(length=20), nullable=True),
    sa.Column('cancel_reason', sa.String(length=500), nullable=True),
    sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['client_id'], ['clients.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_projects_client_id'), ['client_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_projects_status'), ['status'], unique=False)
        batch_op.create_index('ix_projects_workshop_charge', ['workshop_id', 'charge_period'], unique=False)
        batch_op.create_index(batch_op.f('ix_projects_workshop_id'), ['workshop_id'], unique=False)

    op.create_table('refresh_tokens',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('refresh_tokens', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_refresh_tokens_user_id'), ['user_id'], unique=False)

    op.create_table('ai_requests',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=True),
    sa.Column('project_id', sa.Uuid(), nullable=True),
    sa.Column('purpose', sa.String(length=40), nullable=False),
    sa.Column('model', sa.String(length=80), nullable=False),
    sa.Column('tokens_in', sa.Integer(), nullable=False),
    sa.Column('tokens_out', sa.Integer(), nullable=False),
    sa.Column('cache_read_tokens', sa.Integer(), nullable=False),
    sa.Column('cost_microusd', sa.Integer(), nullable=False),
    sa.Column('validation_result', sa.String(length=20), nullable=False),
    sa.Column('validation_errors', sa.JSON(), nullable=True),
    sa.Column('duration_ms', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('ai_requests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_ai_requests_project_id'), ['project_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_ai_requests_workshop_id'), ['workshop_id'], unique=False)

    op.create_table('model_versions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('number', sa.Integer(), nullable=False),
    sa.Column('parent_id', sa.Uuid(), nullable=True),
    sa.Column('source', sa.String(length=10), nullable=False),
    sa.Column('label', sa.String(length=200), nullable=True),
    sa.Column('author_id', sa.Uuid(), nullable=True),
    sa.Column('tree', sa.JSON(), nullable=False),
    sa.Column('product_type', sa.String(length=40), nullable=False),
    sa.Column('schema_version', sa.String(length=20), nullable=False),
    sa.Column('rules_version', sa.String(length=40), nullable=False),
    sa.Column('module_versions', sa.JSON(), nullable=False),
    sa.Column('issues', sa.JSON(), nullable=False),
    sa.Column('summary', sa.JSON(), nullable=False),
    sa.Column('viewer', sa.JSON(), nullable=False),
    sa.Column('ok', sa.Boolean(), nullable=False),
    sa.Column('build_ms', sa.Integer(), nullable=False),
    sa.Column('frozen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['parent_id'], ['model_versions.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('project_id', 'number')
    )
    with op.batch_alter_table('model_versions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_model_versions_project_id'), ['project_id'], unique=False)

    # projects ↔ model_versions ссылаются друг на друга: ключи проекта — после создания версий
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.create_foreign_key(
            'fk_projects_current_version', 'model_versions', ['current_version_id'], ['id'], ondelete='SET NULL'
        )
        batch_op.create_foreign_key(
            'fk_projects_frozen_version', 'model_versions', ['frozen_version_id'], ['id'], ondelete='SET NULL'
        )

    op.create_table('project_photos',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('storage_key', sa.String(length=500), nullable=False),
    sa.Column('url', sa.String(length=1000), nullable=False),
    sa.Column('content_type', sa.String(length=100), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('uploaded_by', sa.Uuid(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['uploaded_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('project_photos', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_project_photos_project_id'), ['project_id'], unique=False)

    op.create_table('project_status_changes',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('from_status', sa.String(length=20), nullable=True),
    sa.Column('to_status', sa.String(length=20), nullable=False),
    sa.Column('actor_user_id', sa.Uuid(), nullable=True),
    sa.Column('actor', sa.String(length=20), nullable=False),
    sa.Column('note', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['actor_user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('project_status_changes', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_project_status_changes_project_id'), ['project_id'], unique=False)

    op.create_table('measurements',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('version_id', sa.Uuid(), nullable=True),
    sa.Column('author_id', sa.Uuid(), nullable=True),
    sa.Column('width', sa.Double(), nullable=True),
    sa.Column('height', sa.Double(), nullable=True),
    sa.Column('depth', sa.Double(), nullable=True),
    sa.Column('data', sa.JSON(), nullable=False),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['version_id'], ['model_versions.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('measurements', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_measurements_project_id'), ['project_id'], unique=False)

    op.create_table('orders',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('version_id', sa.Uuid(), nullable=True),
    sa.Column('supplier', sa.String(length=40), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('estimate_total', sa.Integer(), nullable=True),
    sa.Column('invoice_total', sa.Integer(), nullable=True),
    sa.Column('payment_provider', sa.String(length=20), nullable=True),
    sa.Column('payment_reference', sa.String(length=200), nullable=True),
    sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['version_id'], ['model_versions.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_orders_project_id'), ['project_id'], unique=False)

    op.create_table('share_links',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('version_id', sa.Uuid(), nullable=False),
    sa.Column('token', sa.String(length=64), nullable=False),
    sa.Column('language', sa.String(length=2), nullable=False),
    sa.Column('estimate_view', sa.String(length=10), nullable=False),
    sa.Column('show_price', sa.Boolean(), nullable=False),
    sa.Column('price_snapshot', sa.JSON(), nullable=True),
    sa.Column('price_snapshot_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_by', sa.Uuid(), nullable=True),
    sa.Column('views', sa.Integer(), nullable=False),
    sa.Column('ar_starts', sa.Integer(), nullable=False),
    sa.Column('ar_failures', sa.Integer(), nullable=False),
    sa.Column('first_opened_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('agreed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['version_id'], ['model_versions.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token')
    )
    with op.batch_alter_table('share_links', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_share_links_project_id'), ['project_id'], unique=False)

    op.create_table('share_events',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('share_link_id', sa.Uuid(), nullable=False),
    sa.Column('project_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('user_agent', sa.String(length=500), nullable=True),
    sa.Column('meta', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['share_link_id'], ['share_links.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('share_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_share_events_project_id'), ['project_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_share_events_share_link_id'), ['share_link_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('share_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_share_events_share_link_id'))
        batch_op.drop_index(batch_op.f('ix_share_events_project_id'))

    op.drop_table('share_events')
    with op.batch_alter_table('share_links', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_share_links_project_id'))

    op.drop_table('share_links')
    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_orders_project_id'))

    op.drop_table('orders')
    with op.batch_alter_table('measurements', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_measurements_project_id'))

    op.drop_table('measurements')
    with op.batch_alter_table('project_status_changes', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_status_changes_project_id'))

    op.drop_table('project_status_changes')
    with op.batch_alter_table('project_photos', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_project_photos_project_id'))

    op.drop_table('project_photos')
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_constraint('fk_projects_current_version', type_='foreignkey')
        batch_op.drop_constraint('fk_projects_frozen_version', type_='foreignkey')

    with op.batch_alter_table('model_versions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_model_versions_project_id'))

    op.drop_table('model_versions')
    with op.batch_alter_table('ai_requests', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_ai_requests_workshop_id'))
        batch_op.drop_index(batch_op.f('ix_ai_requests_project_id'))

    op.drop_table('ai_requests')
    with op.batch_alter_table('refresh_tokens', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_refresh_tokens_user_id'))

    op.drop_table('refresh_tokens')
    with op.batch_alter_table('projects', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_projects_workshop_id'))
        batch_op.drop_index('ix_projects_workshop_charge')
        batch_op.drop_index(batch_op.f('ix_projects_status'))
        batch_op.drop_index(batch_op.f('ix_projects_client_id'))

    op.drop_table('projects')
    with op.batch_alter_table('devices', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_devices_user_id'))

    op.drop_table('devices')
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_users_workshop_id'))

    op.drop_table('users')
    with op.batch_alter_table('clients', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_clients_workshop_id'))

    op.drop_table('clients')
    with op.batch_alter_table('action_log', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_action_log_workshop_id'))

    op.drop_table('action_log')
    op.drop_table('workshops')
    with op.batch_alter_table('auth_codes', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_auth_codes_phone'))

    op.drop_table('auth_codes')
