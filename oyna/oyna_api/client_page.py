"""Страница КП для клиента (S11) — HTML по макетам ClientPage / ClientDone / ClientInvalid.

Клиент открывает ссылку из Telegram в браузере: GET /q/{token} с Accept: text/html → эта страница,
приложение и тесты получают JSON. «Согласен» — обычная форма (работает без JavaScript).
"""
from __future__ import annotations

import re
from html import escape

T = {
    "ru": {"total": "Итого", "agree": "Согласен", "call": "Позвонить в цех", "call_short": "Позвонить", "pdf": "PDF",
           "made": "Сделано в Eskiz Oyna", "agreed": "Согласовано", "chosen": "Вы выбрали «{kit}», {sum}. Цех свяжется с вами",
           "gone": "Предложение недоступно", "gone_sub": "Свяжитесь с цехом — пришлют новую ссылку", "demo": "ДЕМО-цены — для показа",
           "extras_note": "монтаж и демонтаж включены в цену изделий", "sum": "сум", "mln": "млн", "old": "Это не последняя версия — показана новая",
           "chambers": "{n} камеры", "glass": "стеклопакет {g}", "price_up": "Цены выросли — цех уточнит сумму"},
    "uz": {"total": "Jami", "agree": "Roziman", "call": "Sexga qo'ng'iroq", "call_short": "Qo'ng'iroq", "pdf": "PDF",
           "made": "Eskiz Oyna'da tayyorlangan", "agreed": "Kelishildi", "chosen": "Siz «{kit}» variantini tanladingiz, {sum}. Sex siz bilan bog'lanadi",
           "gone": "Taklif mavjud emas", "gone_sub": "Sex bilan bog'laning — yangi havola yuborishadi", "demo": "DEMO narxlar — namoyish uchun",
           "extras_note": "o'rnatish va demontaj narxga kiritilgan", "sum": "so'm", "mln": "mln", "old": "Bu oxirgi versiya emas — yangisi ko'rsatildi",
           "chambers": "{n} kamerali", "glass": "{g} oyna paketi", "price_up": "Narxlar oshgan — sex aniqlashtiradi"},
}

CSS = """
body{margin:0;background:#F2F1EE;font-family:Onest,system-ui,-apple-system,sans-serif;color:#21201F;font-size:16px;line-height:22px;letter-spacing:-.005em}
.app{max-width:480px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}
.hdr{display:flex;align-items:center;gap:12px;padding:18px 20px 8px}
.tile{width:44px;height:44px;flex:none;border-radius:14px;background:#F7F7F5;display:flex;align-items:center;justify-content:center;overflow:hidden}
.tile.dk{background:#21201F;color:#fff;font-weight:700}
.rt{font-size:16px;line-height:21px;font-weight:500}.rs{font-size:14px;line-height:19px;color:#6E6B66}.rv{font-size:16px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.seg{display:flex;background:#E6E5E1;border-radius:14px;padding:3px;gap:2px}.seg a{flex:1;height:40px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:500;color:#21201F;text-decoration:none;white-space:nowrap;padding:0 10px}
.seg a.on{background:#fff;box-shadow:0 1px 3px rgba(33,32,31,.10)}
.body{flex:1;padding:8px 12px 12px;display:flex;flex-direction:column;gap:10px}
.sheet{background:#fff;border-radius:28px;overflow:hidden}
.row{display:flex;align-items:center;gap:14px;min-height:60px;padding:10px 20px;box-sizing:border-box}
.row+.row{box-shadow:inset 0 1px 0 #F0EFEC}.tx{flex:1;min-width:0}.line{display:flex;justify-content:space-between;gap:8px}
.tot{display:flex;justify-content:space-between;align-items:baseline;padding:16px 20px;box-shadow:inset 0 1px 0 #F0EFEC}
.title{font-size:22px;line-height:28px;font-weight:700;letter-spacing:-.02em}.num{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
.cap{font-size:14px;color:#6E6B66;text-align:center;padding:4px}
.ban{border-radius:20px;padding:14px 16px;font-size:15px;line-height:21px}.ban .bt{font-weight:600;font-size:16px}
.ban.ok{background:#E6F1EA;color:#1F4A2F}.ban.est{background:#FFF0D4;color:#6E3C00}.ban.info{background:#E3EEFC;color:#154A99}
.foot{padding:10px 12px 30px;display:flex;flex-direction:column;gap:8px;position:sticky;bottom:0;background:linear-gradient(#F2F1EE00,#F2F1EE 30%)}
.fr{display:flex;gap:8px}
.cta{height:56px;border-radius:999px;border:1.2px solid rgba(64,92,138,.95);background:linear-gradient(180deg,#ECF3FC,#C2D6F0 28%,#A6C4EA 62%,#CEE6FD);color:#0F2E5C;font:600 17px Onest,system-ui,sans-serif;width:100%;cursor:pointer;box-shadow:0 10px 22px -10px rgba(30,50,90,.32)}
.soft{flex:1;height:48px;border-radius:999px;background:#fff;color:#21201F;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:500;text-decoration:none}
.center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px;padding:0 32px}
.sub{color:#6E6B66}
"""
FONTS = '<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap" rel="stylesheet">'
PHONE_SVG = ('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
             'stroke-linejoin="round"><path d="M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 6a2 2 0 0 1 2-2z"/></svg>')
DOC_SVG = ('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
           'stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>')


def _sum(v, t) -> str:
    return f"{int(v):,}".replace(",", " ") + f" {t['sum']}"


def _mln(v, t) -> str:
    return (f"{v / 1e6:.2f}".rstrip("0").rstrip(".").replace(".", ",") + f" {t['mln']}") if v >= 1e5 else _sum(v, t)


def _initials(name: str) -> str:
    w = [x for x in re.split(r"\s+", name or "") if x]
    return ((w[0][0] + w[1][0]) if len(w) > 1 else (w[0][:2] if w else "?")).upper()


def _thumb(svg: str | None) -> str:
    if not svg:
        return ""
    return re.sub(r'width="\d+" height="\d+"', 'width="40" height="40" preserveAspectRatio="xMidYMid meet"', svg, count=1)


def _shell(lang: str, title: str, inner: str) -> str:
    return (f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{escape(title)}</title>{FONTS}<style>{CSS}</style></head><body><div class="app">{inner}</div></body></html>')


def _header(head: dict, token: str, lang: str, date: str, extra_q: str = "") -> str:
    langs = "".join(f'<a class="{"on" if l == lang else ""}" href="/q/{token}?lang={l}{extra_q}">{l.upper()}</a>' for l in ("ru", "uz"))
    return (f'<div class="hdr"><span class="tile dk">{escape(_initials(head["company"]))}</span>'
            f'<div style="flex:1;min-width:0"><div class="rt" style="font-weight:700">{escape(head["company"])}</div>'
            f'<div class="rs">{escape(head.get("address") or "")}{" · " + date if date else ""}</div></div>'
            f'<span class="seg" style="width:96px">{langs}</span></div>')


def invalid(head: dict | None, token: str, lang: str) -> str:
    t = T.get(lang, T["ru"])
    top = _header(head, token, lang, "") if head else ""
    call = (f'<a class="soft" style="width:100%;height:56px" href="tel:{escape(head["company_phone"])}">{PHONE_SVG}{t["call"]}</a>'
            if head and head.get("company_phone") else "")
    link = ('<span class="tile" style="width:72px;height:72px;border-radius:24px;background:#fff"><svg width="30" height="30" viewBox="0 0 24 24" '
            'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/>'
            '<path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg></span>')
    return _shell(lang, t["gone"], f'{top}<div class="center">{link}<div class="title">{t["gone"]}</div><div class="sub">{t["gone_sub"]}</div>{call}</div>')


def page(data: dict, token: str, lang: str | None, vi: int | None, warning: dict | None = None) -> str:
    lang = lang if lang in T else data.get("lang", "ru")
    t = T[lang]
    variants = data["variants"]
    accepted = data.get("accepted_variant")
    vi = accepted if accepted is not None else (vi if vi is not None and 0 <= vi < len(variants) else 0)
    v = variants[vi]
    date = (data.get("sent_at") or "")[8:10] + "." + (data.get("sent_at") or "")[5:7] if data.get("sent_at") else ""
    out = [_header(data, token, lang, date, f"&v={vi}")]
    out.append('<div class="body">')
    if not data.get("is_latest", True):
        out.append(f'<div class="ban info">{t["old"]}</div>')
    if warning:
        out.append(f'<div class="ban est">{t["price_up"]}</div>')
    if accepted is not None:
        out.append(f'<div class="ban ok"><div class="bt">{t["agreed"]} {(data.get("accepted_at") or "")[8:10]}.{(data.get("accepted_at") or "")[5:7]}</div>'
                   f'<div>{escape(t["chosen"].format(kit=v["kit"], sum=_sum(v["total"], t)))}</div></div>')
    elif len(variants) > 1:
        segs = "".join(f'<a class="{"on" if i == vi else ""}" href="/q/{token}?lang={lang}&v={i}">{escape(x["kit"])} · {_mln(x["total"], t)}</a>'
                       for i, x in enumerate(variants))
        out.append(f'<div class="seg">{segs}</div>')
    if data.get("demo"):
        out.append(f'<div class="ban est">{t["demo"]}</div>')
    rows = []
    for p in v["positions"]:
        d = p.get("desc") or {}
        bits = [f'{p["w"]} × {p["h"]}']
        sysbit = d.get("system", "")
        if d.get("chambers"):
            sysbit += ", " + t["chambers"].format(n=d["chambers"])
        bits += [b for b in (sysbit, t["glass"].format(g=d.get("glass", "")) if d.get("glass") else "", d.get("fittings", "")) if b]
        bits += d.get("extras") or []
        title = escape(p.get("room") or "—") + (f' × {p["qty"]}' if (p.get("qty") or 1) > 1 else "")
        rows.append(f'<div class="row"><span class="tile">{_thumb(p.get("svg"))}</span><div class="tx"><div class="line">'
                    f'<span class="rt">{title}</span><span class="rv">{_mln(p["total"] or 0, t)}</span></div>'
                    f'<div class="rs">{escape(" · ".join(bits))}</div></div></div>')
    for e in v.get("extras") or []:
        rows.append(f'<div class="row"><div class="tx"><div class="rt">{escape(e["name"])}{" × " + str(int(e["qty"])) if e["qty"] != 1 else ""}</div>'
                    f'<div class="rs">{t["extras_note"]}</div></div><span class="rv">{_mln(e["total"], t)}</span></div>')
    rows.append(f'<div class="tot"><span class="title">{t["total"]}</span><span class="num">{_sum(v["total"], t)}</span></div>')
    out.append(f'<div class="sheet">{"".join(rows)}</div>')
    if data.get("eskiz_badge"):
        out.append(f'<div class="cap">{t["made"]}</div>')
    out.append("</div>")
    phone = data.get("company_phone")
    call = f'<a class="soft" href="tel:{escape(phone)}">{PHONE_SVG}{t["call"] if accepted is None else t["call_short"]}</a>' if phone else ""
    pdf = f'<a class="soft" href="/q/{token}/pdf">{DOC_SVG}{t["pdf"]}</a>'
    foot = '<div class="foot">'
    if accepted is None:
        foot += (f'<form method="post" action="/q/{token}/agree?lang={lang}"><input type="hidden" name="variant" value="{vi}">'
                 f'<button class="cta" type="submit">{t["agree"]} · {_sum(v["total"], t)}</button></form>')
    foot += f'<div class="fr">{call}{pdf}</div></div>'
    out.append(foot)
    return _shell(lang, f'{data["company"]} — КП', "".join(out))
