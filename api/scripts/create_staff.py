"""Создать сотрудника (первый суперадмин, владелец поставщика…) и напечатать временный пароль.

    uv run python scripts/create_staff.py --email boss@eskizai.uz --name "Тимур" --role superadmin
    uv run python scripts/create_staff.py --email owner@eman.uz --name "EMAN" --role vendor_owner --supplier eman \\
        [--database-url postgresql+psycopg://…]   # по умолчанию — DATABASE_URL из окружения / .env

Пароль временный: при первом входе его нужно сменить; суперадмину при первом входе — включить 2FA.
Пароль печатается один раз и нигде не хранится (в базе — только хеш scrypt).
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sqlalchemy import select  # noqa: E402

from mebel_api.db import Database  # noqa: E402
from mebel_api.models import Supplier  # noqa: E402
from mebel_api.services import staff_auth as sa  # noqa: E402


def create(db: Database, *, email: str, name: str, role: str, supplier: str | None) -> tuple[str, str]:
    from mebel_api.errors import ApiError
    from mebel_api.routers.staff import create_staff

    if role not in sa.ROLES:
        raise SystemExit(f"Неизвестная роль {role}. Роли: {', '.join(sa.ROLES)}")
    with db.sessionmaker() as s:
        supplier_id = None
        if role in sa.VENDOR_ROLES:
            if not supplier:
                raise SystemExit("Для роли поставщика укажите --supplier <код поставщика>")
            sup = s.scalar(select(Supplier).where(Supplier.code == supplier))
            if sup is None:
                from mebel_api.services.catalog.pipeline import ensure_supplier

                try:
                    sup = ensure_supplier(s, supplier)
                except ApiError:
                    raise SystemExit(f"Поставщик {supplier} не найден — создайте его в админке") from None
            supplier_id = sup.id
        elif supplier:
            raise SystemExit("Роль платформы — без --supplier")
        try:
            user, password = create_staff(s, "script:create_staff", email=email, name=name, role=role,
                                          supplier_id=supplier_id, actor_type="system")
        except ApiError as e:
            raise SystemExit(e.message) from None
        s.commit()
        return str(user.id), password


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--email", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--role", required=True, choices=sorted(sa.ROLES))
    ap.add_argument("--supplier", help="код поставщика (для vendor_owner / vendor_designer)")
    ap.add_argument("--database-url", help="по умолчанию — DATABASE_URL из настроек")
    a = ap.parse_args()
    url = a.database_url
    if not url:
        from mebel_api.config import get_settings

        url = get_settings().database_url
    uid, password = create(Database(url), email=a.email, name=a.name, role=a.role, supplier=a.supplier)
    print(f"Сотрудник создан: {a.email.strip().lower()} ({a.role}), id {uid}")
    print(f"Временный пароль (показывается один раз): {password}")


if __name__ == "__main__":
    main()
