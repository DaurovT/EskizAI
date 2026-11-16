"""Входящие чертежи из Eskiz DWG и область токенов мастера (docs/dwg_contract.md).

Revision ID: 0013
Revises: 0012
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from mebel_api.db import UTCDateTime

revision: str = '0013'
down_revision: Union[str, None] = '0012'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('refresh_tokens', schema=None) as batch_op:
        batch_op.add_column(sa.Column('scope', sa.String(length=20), server_default='full', nullable=False))

    op.create_table(
        'inbox_drawings',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('workshop_id', sa.Uuid(), nullable=True),
        sa.Column('filename', sa.String(length=200), nullable=False),
        sa.Column('size', sa.Integer(), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('storage_key', sa.String(length=500), nullable=False),
        sa.Column('preview_key', sa.String(length=500), nullable=True),
        sa.Column('title', sa.String(length=200), nullable=True),
        sa.Column('manifest', sa.JSON(), nullable=True),
        sa.Column('created_at', UTCDateTime(), nullable=False),
        sa.Column('last_opened_at', UTCDateTime(), nullable=True),
        sa.Column('expires_at', UTCDateTime(), nullable=False),
        sa.Column('deleted_at', UTCDateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['workshop_id'], ['workshops.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('inbox_drawings', schema=None) as batch_op:
        batch_op.create_index('ix_inbox_drawings_user_created', ['user_id', 'created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_inbox_drawings_sha256'), ['sha256'], unique=False)
        batch_op.create_index(batch_op.f('ix_inbox_drawings_expires_at'), ['expires_at'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('inbox_drawings', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_inbox_drawings_expires_at'))
        batch_op.drop_index(batch_op.f('ix_inbox_drawings_sha256'))
        batch_op.drop_index('ix_inbox_drawings_user_created')
    op.drop_table('inbox_drawings')
    with op.batch_alter_table('refresh_tokens', schema=None) as batch_op:
        batch_op.drop_column('scope')
