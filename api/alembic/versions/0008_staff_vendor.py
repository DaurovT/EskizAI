"""Сотрудники (почта + пароль, 2FA, сессии), поставщики (маршруты, комиссии, выплаты, источник цен),
заказ у поставщика (конструктор, переписка, история, исправления, возвраты, споры).
docs/staff_vendor_contract.md, ред. 3.

Безопасно на живой базе: только новые таблицы и nullable-колонки; заполнение — UPDATE по существующим данным
(orders.supplier_id по коду поставщика, недостающие поставщики создаются; заявки нестандарта и позиции
«под запрос» — EMAN). На SQLite колонки с внешним ключом добавляются пересборкой таблицы (batch); на эти
таблицы никто не ссылается, данные копируются.

Revision ID: 0008
Revises: 0007
"""
import uuid
from datetime import UTC, datetime
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from mebel_api.db import UTCDateTime

revision: str = '0008'
down_revision: Union[str, None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DT = sa.DateTime(timezone=True)

_suppliers = sa.table(
    'suppliers',
    sa.column('id', sa.Uuid()), sa.column('code', sa.String()), sa.column('name', sa.String()),
    sa.column('order_method', sa.String()), sa.column('commission_bp', sa.Integer()),
    sa.column('contacts', sa.JSON()), sa.column('site_url', sa.String()), sa.column('active', sa.Boolean()),
    sa.column('created_at', UTCDateTime()), sa.column('settings', sa.JSON()),
)


def _ensure_suppliers(conn) -> None:
    """EMAN всегда; плюс каждый код поставщика, который уже встречается в заказах."""
    codes = {'eman'} | {c for (c,) in conn.execute(sa.text('SELECT DISTINCT supplier FROM orders')) if c}
    have = {c for (c,) in conn.execute(sa.text('SELECT code FROM suppliers'))}
    now = datetime.now(UTC)
    for code in sorted(codes - have):
        eman = code == 'eman'
        conn.execute(_suppliers.insert().values(
            id=uuid.uuid4(), code=code, name='EMAN Materials' if eman else code.upper(), order_method='manual_csv',
            commission_bp=0, contacts={}, site_url='https://eman.uz' if eman else None, active=True,
            created_at=now, settings={},
        ))


def upgrade() -> None:
    conn = op.get_bind()

    # --- Поставщики: реквизиты и настройки, причина блокировки ---
    op.add_column('suppliers', sa.Column('settings', sa.JSON(), server_default='{}', nullable=False))
    op.add_column('suppliers', sa.Column('blocked_reason', sa.String(length=500), nullable=True))

    # --- Сотрудники ---
    op.create_table('staff_users',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('email', sa.String(length=254), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('role', sa.String(length=30), nullable=False),
    sa.Column('supplier_id', sa.Uuid(), nullable=True),
    sa.Column('password_hash', sa.String(length=300), nullable=False),
    sa.Column('must_change_password', sa.Boolean(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('failed_logins', sa.Integer(), server_default='0', nullable=False),
    sa.Column('locked_until', DT, nullable=True),
    sa.Column('last_login_at', DT, nullable=True),
    sa.Column('password_changed_at', DT, nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.Column('updated_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('email'),
    )
    op.create_index('ix_staff_users_supplier_id', 'staff_users', ['supplier_id'], unique=False)

    op.create_table('staff_sessions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('staff_id', sa.Uuid(), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('user_agent', sa.String(length=300), nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.Column('last_seen_at', DT, nullable=False),
    sa.Column('revoked_at', DT, nullable=True),
    sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_staff_sessions_staff_id', 'staff_sessions', ['staff_id'], unique=False)

    op.create_table('staff_refresh_tokens',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('staff_id', sa.Uuid(), nullable=False),
    sa.Column('session_id', sa.Uuid(), nullable=True),
    sa.Column('expires_at', DT, nullable=False),
    sa.Column('revoked_at', DT, nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['session_id'], ['staff_sessions.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_staff_refresh_tokens_staff_id', 'staff_refresh_tokens', ['staff_id'], unique=False)
    op.create_index('ix_staff_refresh_tokens_session_id', 'staff_refresh_tokens', ['session_id'], unique=False)

    op.create_table('staff_mfa',
    sa.Column('staff_id', sa.Uuid(), nullable=False),
    sa.Column('secret', sa.String(length=64), nullable=False),
    sa.Column('backup_codes', sa.JSON(), nullable=False),
    sa.Column('enabled_at', DT, nullable=True),
    sa.Column('last_step', sa.Integer(), nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['staff_id'], ['staff_users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('staff_id'),
    )

    # --- Поставщики: маршруты, комиссии, выплаты, источник цен ---
    op.create_table('supplier_routes',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('category', sa.String(length=40), nullable=False),
    sa.Column('supplier_id', sa.Uuid(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', DT, nullable=False),
    sa.Column('updated_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('category'),
    )
    op.create_index('ix_supplier_routes_supplier_id', 'supplier_routes', ['supplier_id'], unique=False)

    op.create_table('supplier_commissions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('supplier_id', sa.Uuid(), nullable=False),
    sa.Column('category', sa.String(length=40), nullable=True),
    sa.Column('rate_bp', sa.Integer(), nullable=False),
    sa.Column('effective_from', DT, nullable=False),
    sa.Column('reason', sa.String(length=500), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_supplier_commissions_supplier_id', 'supplier_commissions', ['supplier_id'], unique=False)

    op.create_table('supplier_settlements',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('supplier_id', sa.Uuid(), nullable=False),
    sa.Column('period_from', DT, nullable=True),
    sa.Column('period_to', DT, nullable=True),
    sa.Column('amount', sa.Integer(), nullable=False),
    sa.Column('paid_at', DT, nullable=False),
    sa.Column('comment', sa.String(length=1000), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_supplier_settlements_supplier_id', 'supplier_settlements', ['supplier_id'], unique=False)

    op.create_table('supplier_price_sources',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('supplier_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('url', sa.String(length=1000), nullable=False),
    sa.Column('format', sa.String(length=10), nullable=False),
    sa.Column('mapping', sa.JSON(), nullable=False),
    sa.Column('secret', sa.String(length=500), nullable=True),
    sa.Column('schedule', sa.String(length=10), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('last_run_at', DT, nullable=True),
    sa.Column('last_status', sa.String(length=20), nullable=True),
    sa.Column('last_error', sa.String(length=1000), nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.Column('updated_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['supplier_id'], ['suppliers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('supplier_id'),
    )

    _ensure_suppliers(conn)

    # --- Заказы: поставщик, группа, конструктор, срок, причины, комиссия ---
    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.add_column(sa.Column('supplier_id', sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column('group_id', sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column('vendor_status_note', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('assignee_id', sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column('due_date', DT, nullable=True))
        batch_op.add_column(sa.Column('reject_reason', sa.String(length=500), nullable=True))
        batch_op.add_column(sa.Column('return_comment', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('accepted_at', DT, nullable=True))
        batch_op.add_column(sa.Column('commission_amount', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('commission_reversed', sa.Integer(), server_default='0', nullable=False))
        batch_op.create_foreign_key('fk_orders_supplier_id', 'suppliers', ['supplier_id'], ['id'], ondelete='SET NULL')
        batch_op.create_foreign_key('fk_orders_assignee_id', 'staff_users', ['assignee_id'], ['id'],
                                    ondelete='SET NULL')
        batch_op.create_index('ix_orders_supplier_id', ['supplier_id'], unique=False)
        batch_op.create_index('ix_orders_group_id', ['group_id'], unique=False)
        batch_op.create_index('ix_orders_assignee_id', ['assignee_id'], unique=False)
    conn.execute(sa.text('UPDATE orders SET supplier_id = (SELECT s.id FROM suppliers s WHERE s.code = orders.supplier)'
                         ' WHERE supplier_id IS NULL'))
    conn.execute(sa.text('UPDATE orders SET group_id = id WHERE group_id IS NULL'))

    # --- Нестандарт и позиции «под запрос»: кому ушли (сейчас всё — EMAN) ---
    with op.batch_alter_table('nonstandard_requests', schema=None) as batch_op:
        batch_op.add_column(sa.Column('supplier_id', sa.Uuid(), nullable=True))
        batch_op.add_column(sa.Column('assignee_staff_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key('fk_nonstandard_requests_supplier_id', 'suppliers', ['supplier_id'], ['id'],
                                    ondelete='SET NULL')
        batch_op.create_foreign_key('fk_nonstandard_requests_assignee_staff_id', 'staff_users',
                                    ['assignee_staff_id'], ['id'], ondelete='SET NULL')
        batch_op.create_index('ix_nonstandard_requests_supplier_id', ['supplier_id'], unique=False)
    with op.batch_alter_table('price_requests', schema=None) as batch_op:
        batch_op.add_column(sa.Column('supplier_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key('fk_price_requests_supplier_id', 'suppliers', ['supplier_id'], ['id'],
                                    ondelete='SET NULL')
        batch_op.create_index('ix_price_requests_supplier_id', ['supplier_id'], unique=False)
    eman = "(SELECT s.id FROM suppliers s WHERE s.code = 'eman')"
    conn.execute(sa.text(f"UPDATE nonstandard_requests SET supplier_id = {eman} "
                         "WHERE supplier_id IS NULL AND path <> 'self'"))
    conn.execute(sa.text(f'UPDATE price_requests SET supplier_id = {eman} WHERE supplier_id IS NULL'))

    # --- Заказ: переписка, история, исправления, возвраты, споры ---
    op.create_table('order_messages',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('order_id', sa.Uuid(), nullable=False),
    sa.Column('author_type', sa.String(length=10), nullable=False),
    sa.Column('author_id', sa.String(length=64), nullable=True),
    sa.Column('author_name', sa.String(length=200), nullable=True),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('attachments', sa.JSON(), nullable=False),
    sa.Column('created_at', DT, nullable=False),
    sa.Column('read_by_master_at', DT, nullable=True),
    sa.Column('read_by_vendor_at', DT, nullable=True),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_order_messages_order_id', 'order_messages', ['order_id'], unique=False)

    op.create_table('order_events',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('order_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('from_status', sa.String(length=20), nullable=True),
    sa.Column('to_status', sa.String(length=20), nullable=True),
    sa.Column('actor_type', sa.String(length=10), nullable=False),
    sa.Column('actor_id', sa.String(length=64), nullable=True),
    sa.Column('actor_name', sa.String(length=200), nullable=True),
    sa.Column('comment', sa.Text(), nullable=True),
    sa.Column('data', sa.JSON(), nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_order_events_order_id', 'order_events', ['order_id'], unique=False)

    op.create_table('order_corrections',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('order_id', sa.Uuid(), nullable=False),
    sa.Column('author_id', sa.Uuid(), nullable=True),
    sa.Column('comment', sa.Text(), nullable=False),
    sa.Column('lines_before', sa.JSON(), nullable=False),
    sa.Column('lines_after', sa.JSON(), nullable=False),
    sa.Column('total_before', sa.Integer(), nullable=False),
    sa.Column('total_after', sa.Integer(), nullable=False),
    sa.Column('files', sa.JSON(), nullable=False),
    sa.Column('prev_status', sa.String(length=20), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('decision_comment', sa.Text(), nullable=True),
    sa.Column('decided_by', sa.Uuid(), nullable=True),
    sa.Column('decided_at', DT, nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['staff_users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['decided_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_order_corrections_order_id', 'order_corrections', ['order_id'], unique=False)

    op.create_table('order_returns',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('order_id', sa.Uuid(), nullable=False),
    sa.Column('opened_by_type', sa.String(length=10), nullable=False),
    sa.Column('opened_by', sa.String(length=64), nullable=True),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('lines', sa.JSON(), nullable=False),
    sa.Column('amount', sa.Integer(), nullable=True),
    sa.Column('photos', sa.JSON(), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('decision', sa.String(length=20), nullable=True),
    sa.Column('decision_comment', sa.Text(), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('refund_amount', sa.Integer(), nullable=True),
    sa.Column('decided_by', sa.String(length=64), nullable=True),
    sa.Column('decided_at', DT, nullable=True),
    sa.Column('approved_by', sa.String(length=64), nullable=True),
    sa.Column('resolved_at', DT, nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.Column('updated_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_order_returns_order_id', 'order_returns', ['order_id'], unique=False)

    op.create_table('order_disputes',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('order_id', sa.Uuid(), nullable=False),
    sa.Column('return_id', sa.Uuid(), nullable=True),
    sa.Column('opened_by', sa.Uuid(), nullable=True),
    sa.Column('subject', sa.String(length=20), nullable=False),
    sa.Column('reason', sa.String(length=40), nullable=False),
    sa.Column('comment', sa.Text(), nullable=False),
    sa.Column('photos', sa.JSON(), nullable=False),
    sa.Column('lines', sa.JSON(), nullable=False),
    sa.Column('amount', sa.Integer(), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('resolution', sa.String(length=20), nullable=True),
    sa.Column('refund_amount', sa.Integer(), nullable=True),
    sa.Column('decision_comment', sa.Text(), nullable=True),
    sa.Column('resolved_by', sa.String(length=64), nullable=True),
    sa.Column('resolved_at', DT, nullable=True),
    sa.Column('created_at', DT, nullable=False),
    sa.ForeignKeyConstraint(['opened_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['order_id'], ['orders.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['return_id'], ['order_returns.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_order_disputes_order_id', 'order_disputes', ['order_id'], unique=False)


def downgrade() -> None:
    for table in ('order_disputes', 'order_returns', 'order_corrections', 'order_events', 'order_messages'):
        op.drop_index(f'ix_{table}_order_id', table_name=table)
        op.drop_table(table)
    with op.batch_alter_table('price_requests', schema=None) as batch_op:
        batch_op.drop_index('ix_price_requests_supplier_id')
        batch_op.drop_constraint('fk_price_requests_supplier_id', type_='foreignkey')
        batch_op.drop_column('supplier_id')
    with op.batch_alter_table('nonstandard_requests', schema=None) as batch_op:
        batch_op.drop_index('ix_nonstandard_requests_supplier_id')
        batch_op.drop_constraint('fk_nonstandard_requests_assignee_staff_id', type_='foreignkey')
        batch_op.drop_constraint('fk_nonstandard_requests_supplier_id', type_='foreignkey')
        batch_op.drop_column('assignee_staff_id')
        batch_op.drop_column('supplier_id')
    with op.batch_alter_table('orders', schema=None) as batch_op:
        batch_op.drop_index('ix_orders_assignee_id')
        batch_op.drop_index('ix_orders_group_id')
        batch_op.drop_index('ix_orders_supplier_id')
        batch_op.drop_constraint('fk_orders_assignee_id', type_='foreignkey')
        batch_op.drop_constraint('fk_orders_supplier_id', type_='foreignkey')
        for col in ('commission_reversed', 'commission_amount', 'accepted_at', 'return_comment', 'reject_reason',
                    'due_date', 'assignee_id', 'vendor_status_note', 'group_id', 'supplier_id'):
            batch_op.drop_column(col)
    op.drop_table('supplier_price_sources')
    op.drop_index('ix_supplier_settlements_supplier_id', table_name='supplier_settlements')
    op.drop_table('supplier_settlements')
    op.drop_index('ix_supplier_commissions_supplier_id', table_name='supplier_commissions')
    op.drop_table('supplier_commissions')
    op.drop_index('ix_supplier_routes_supplier_id', table_name='supplier_routes')
    op.drop_table('supplier_routes')
    op.drop_table('staff_mfa')
    op.drop_index('ix_staff_refresh_tokens_session_id', table_name='staff_refresh_tokens')
    op.drop_index('ix_staff_refresh_tokens_staff_id', table_name='staff_refresh_tokens')
    op.drop_table('staff_refresh_tokens')
    op.drop_index('ix_staff_sessions_staff_id', table_name='staff_sessions')
    op.drop_table('staff_sessions')
    op.drop_index('ix_staff_users_supplier_id', table_name='staff_users')
    op.drop_table('staff_users')
    # Без пересборки: на suppliers ссылаются catalog_items (CASCADE) — SQLite ≥ 3.35 умеет DROP COLUMN
    op.drop_column('suppliers', 'blocked_reason')
    op.drop_column('suppliers', 'settings')
