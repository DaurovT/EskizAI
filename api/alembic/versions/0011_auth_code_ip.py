"""IP запроса кода входа — лимиты на IP против SMS-накрутки.

Revision ID: 0011
Revises: 0009 (0010, если появится — перевесить)

Номер 0011: 0009 и 0010 зарезервированы под параллельные правки; если они появятся,
down_revision нужно перевесить на последнюю из них.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0011'
down_revision: Union[str, None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('auth_codes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('ip', sa.String(length=45), nullable=True))
        batch_op.create_index(batch_op.f('ix_auth_codes_ip'), ['ip'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('auth_codes', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_auth_codes_ip'))
        batch_op.drop_column('ip')
