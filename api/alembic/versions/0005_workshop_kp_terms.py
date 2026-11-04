"""Условия для КП в профиле цеха: срок, оплата, гарантия (SCR-02, PDF-1).

Revision ID: 0005
Revises: 0004
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0005'
down_revision: Union[str, None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('workshops') as b:
        b.add_column(sa.Column('kp_lead', sa.String(length=300), nullable=True))
        b.add_column(sa.Column('kp_payment', sa.String(length=300), nullable=True))
        b.add_column(sa.Column('kp_warranty', sa.String(length=300), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('workshops') as b:
        b.drop_column('kp_warranty')
        b.drop_column('kp_payment')
        b.drop_column('kp_lead')
