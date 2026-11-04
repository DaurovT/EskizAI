"""employee invites, user permissions, account deletion, code purpose

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-03 12:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0004'
down_revision: Union[str, None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Приглашения сотрудников на 7 дней (SCR-38a), права сотрудника (SCR-23),
    # удаление аккаунта (SCR-44) и назначение одноразового кода
    op.create_table('invites',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('workshop_id', sa.Uuid(), nullable=False),
    sa.Column('phone', sa.String(length=20), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('title', sa.String(length=60), nullable=True),
    sa.Column('can_see_cost', sa.Boolean(), nullable=False),
    sa.Column('can_order', sa.Boolean(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('invited_by', sa.Uuid(), nullable=True),
    sa.Column('user_id', sa.Uuid(), nullable=True),
    sa.Column('sent_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['invited_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('invites', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_invites_phone'), ['phone'], unique=False)
        batch_op.create_index(batch_op.f('ix_invites_workshop_id'), ['workshop_id'], unique=False)

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('title', sa.String(length=60), nullable=True))
        batch_op.add_column(sa.Column('can_see_cost', sa.Boolean(), server_default=sa.false(), nullable=False))
        batch_op.add_column(sa.Column('can_order', sa.Boolean(), server_default=sa.false(), nullable=False))
        batch_op.add_column(sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))

    with op.batch_alter_table('workshops', schema=None) as batch_op:
        batch_op.add_column(sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))

    with op.batch_alter_table('auth_codes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('purpose', sa.String(length=20), server_default='login', nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('auth_codes', schema=None) as batch_op:
        batch_op.drop_column('purpose')

    with op.batch_alter_table('workshops', schema=None) as batch_op:
        batch_op.drop_column('deleted_at')

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('deleted_at')
        batch_op.drop_column('can_order')
        batch_op.drop_column('can_see_cost')
        batch_op.drop_column('title')

    with op.batch_alter_table('invites', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_invites_workshop_id'))
        batch_op.drop_index(batch_op.f('ix_invites_phone'))

    op.drop_table('invites')
