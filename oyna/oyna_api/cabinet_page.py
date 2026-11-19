"""HTML веб-кабинета цен (макет app/docs/design/CatalogWeb.dc.html): одна страница, чистый JS, без сборки.

Данные — JSON API (/oyna/company/…, /oyna/catalog/…) с cookie-сессией и заголовком X-CSRF-Token.
Разделы (#hash): каталог и цены, стекло, работы, поставщики, импорт Excel/CSV, наценка, версии цен.
"""
from __future__ import annotations

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap" rel="stylesheet">')

CSS = r"""
:root{--bg:#F4F3EF;--card:#fff;--ink:#21201F;--sub:#6E6B66;--mute:#9C9993;--line:#F0EFEC;--soft:#F4F3EF;--blue:#1E6FD9;--blue-ink:#154A99;
--blue-bg:#E3EEFC;--green:#275C3A;--green-bg:#E6F1EA;--amber:#8A4B00;--amber-bg:#FFF0D4;--red:#A1221A;--red-bg:#FFE7E4;--seg:#E6E5E1}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:Onest,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:21px;letter-spacing:-.005em}
a{color:#185BB8;text-decoration:none}
button,input,select{font:inherit;color:inherit}
button{border:0;background:none;padding:0;cursor:pointer}
.hidden{display:none!important}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.web{display:flex;gap:12px;padding:12px;min-height:100vh}
.side{width:232px;flex:none;background:var(--card);border-radius:24px;padding:16px 12px;display:flex;flex-direction:column;gap:4px;position:sticky;top:12px;height:calc(100vh - 24px)}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px 14px;font-weight:700;font-size:16px}
.logo{width:36px;height:36px;border-radius:10px;background:var(--blue);display:flex;align-items:center;justify-content:center;color:#fff;flex:none}
.nav a{height:44px;border-radius:14px;display:flex;align-items:center;gap:10px;padding:0 12px;color:var(--ink);font-weight:500;white-space:nowrap}
.nav a:hover{background:var(--soft)}
.nav a.on{background:var(--blue-bg);color:var(--blue-ink)}
.nav{display:flex;flex-direction:column;gap:2px}
.side .grow{flex:1}
.who{padding:10px 8px 4px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.who .co{font-weight:600}.who .ph{color:var(--sub);font-size:13px}
.main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;padding-bottom:40px}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 4px}
.h1{font-size:28px;line-height:34px;font-weight:700;letter-spacing:-.025em;margin:0}
.grow{flex:1}
.sub{color:var(--sub)}.cap{font-size:13px;line-height:18px;color:var(--sub)}
.sheet{background:var(--card);border-radius:24px;overflow:hidden}
.pad{padding:18px 20px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cta{height:44px;border-radius:999px;padding:0 18px;font-weight:600;background:var(--blue);color:#fff;display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}
.cta:disabled{background:var(--seg);color:var(--mute);cursor:default}
.soft{height:44px;border-radius:999px;padding:0 16px;font-weight:500;background:var(--card);display:inline-flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}
.sheet .soft,.pad .soft{background:var(--soft)}
.soft.sm,.cta.sm{height:36px;padding:0 12px;font-size:14px}
.link{color:#185BB8;font-weight:500}
.danger{color:var(--red)}
.seg{display:inline-flex;background:var(--seg);border-radius:14px;padding:3px;gap:2px}
.seg button{height:36px;border-radius:11px;padding:0 14px;font-weight:500;white-space:nowrap}
.seg button.on{background:#fff;box-shadow:0 1px 3px rgba(33,32,31,.10)}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{height:36px;border-radius:18px;background:var(--card);padding:0 14px;font-weight:500;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.chip .n{color:var(--mute)}
.chip.on{background:var(--ink);color:#fff}.chip.on .n{color:#A9A6A0}
.chip.red{color:var(--red)}.chip.red.on{color:#fff}
.in,.sel{height:44px;border-radius:14px;border:0;background:var(--card);padding:0 14px;min-width:0;outline:0}
.sheet .in,.sheet .sel,.pad .in,.pad .sel{background:var(--soft)}
.in:focus,.sel:focus{box-shadow:inset 0 0 0 2px var(--blue);background:#fff}
.sel{appearance:none;-webkit-appearance:none;padding-right:34px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%236E6B66' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}
.search{width:100%}
input[type=file].in{padding:10px 14px;height:auto;min-height:44px}
label.f{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--sub)}
label.f .in,label.f .sel{color:var(--ink);font-size:15px}
table{width:100%;border-collapse:collapse}
th{font-size:13px;color:var(--sub);font-weight:500;text-align:left;padding:12px 14px;white-space:nowrap}
td{padding:8px 14px;height:56px;box-shadow:inset 0 1px 0 var(--line);vertical-align:middle}
.r{text-align:right}
.art{font-weight:500}.meta{font-size:13px;color:var(--sub);line-height:18px}
.tag{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:7px;font-size:12px;font-weight:600;white-space:nowrap;vertical-align:middle}
.tag.est{background:var(--amber-bg);color:var(--amber)}.tag.info{background:var(--blue-bg);color:var(--blue-ink)}
.tag.ok{background:var(--green-bg);color:var(--green)}.tag.n{background:var(--soft);color:#55524D}.tag.err{background:var(--red-bg);color:var(--red)}
.pin{width:132px;height:40px;border-radius:12px;border:0;background:var(--soft);text-align:right;padding:0 12px;font-weight:600;font-variant-numeric:tabular-nums;outline:0}
.pin::placeholder{color:#B4B1AB;font-weight:500}
.pin:focus{background:#fff;box-shadow:inset 0 0 0 2px var(--blue)}
.pin.saving{opacity:.5}.pin.saved{box-shadow:inset 0 0 0 2px #5DB57A}.pin.err{box-shadow:inset 0 0 0 2px #E5352B;background:#FFF5F4}
.ban{border-radius:18px;padding:14px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ban.ok{background:var(--green-bg);color:#1F4A2F}.ban.est{background:var(--amber-bg);color:#6E3C00}.ban.info{background:var(--blue-bg);color:var(--blue-ink)}.ban.err{background:var(--red-bg);color:#8A1D16}
.ban b{font-weight:600}
.more{display:flex;justify-content:center;padding:12px}
.empty{padding:40px 20px;text-align:center;color:var(--sub)}
.grid2{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.card{background:var(--card);border-radius:20px;padding:16px;display:flex;flex-direction:column;gap:8px}
.card .t{font-weight:600;font-size:16px}
.steps{display:flex;gap:6px}.steps i{flex:1;height:5px;border-radius:3px;background:var(--seg);display:block}.steps i.d{background:var(--blue)}
.mapg{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
.scroll{overflow-x:auto}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:#fff;border-radius:16px;padding:14px 18px;font-weight:500;z-index:30;max-width:calc(100vw - 32px);box-shadow:0 10px 30px rgba(0,0,0,.2)}
.toast.err{background:#8A1D16}
.scrim{position:fixed;inset:0;background:rgba(33,32,31,.42);z-index:20;display:flex;align-items:center;justify-content:center;padding:16px}
.modal{background:#fff;border-radius:24px;width:min(560px,100%);max-height:85vh;overflow:auto;padding:20px}
.modal h3{margin:0 0 4px;font-size:20px}
.hl{display:flex;justify-content:space-between;gap:12px;padding:10px 0;box-shadow:inset 0 -1px 0 var(--line)}
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
.lcard{background:#fff;border-radius:28px;padding:28px 24px;width:min(400px,100%);display:flex;flex-direction:column;gap:14px}
.lcard .in{background:var(--soft);height:52px;font-size:17px}
.lcard .cta{height:52px;font-size:16px}
.co-btn{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:56px;padding:0 16px;border-radius:16px;background:var(--soft);font-weight:500}
.muted{color:var(--mute)}
@media (max-width:900px){
 .web{flex-direction:column;padding:8px;gap:8px}
 .side{width:auto;height:auto;position:static;flex-direction:row;align-items:center;padding:8px;border-radius:20px;gap:6px;overflow:hidden}
 .brand{padding:0 6px 0 2px}.brand span:not(.logo){display:none}
 .nav{flex-direction:row;overflow-x:auto;scrollbar-width:none;flex:1}.nav::-webkit-scrollbar{display:none}
 .nav a{height:38px;padding:0 12px;font-size:14px}.nav a svg{display:none}
 .side .grow{display:none}
 .who{border:0;padding:0;flex-direction:row}.who .co,.who .ph,.who select{display:none}
 .h1{font-size:24px;line-height:30px}
 .seg{display:flex;flex-wrap:wrap;max-width:100%}.seg button{flex:1 1 auto}
 .main{padding-bottom:24px}
 .row>.sel,.row>label.f{flex:1 1 140px!important;min-width:0}.row>.sel{max-width:none!important}
 .top .sel,.top .in{flex:1 1 140px}
 table.cards thead{display:none}
 table.cards,table.cards tbody,table.cards tr,table.cards td{display:block;width:100%}
 table.cards tr{padding:12px 16px;box-shadow:inset 0 1px 0 var(--line)}
 table.cards tr:first-child{box-shadow:none}
 table.cards td{height:auto;padding:3px 0;box-shadow:none;display:flex;justify-content:space-between;align-items:center;gap:10px;text-align:right}
 table.cards td[data-l]::before{content:attr(data-l);color:var(--sub);font-size:13px;text-align:left}
 table.cards td.first{display:block;text-align:left;padding-bottom:6px}
 .pin{width:150px}
}
"""

JS = r"""
'use strict';
const S = {session: null, filters: null, suppliers: null, sec: 'catalog', cat: {offset: 0, flag: '', q: '', category: '', system: '', role: '', color: '', supplier: ''}};
const $ = (s, el) => (el || document).querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = v => v == null || v === '' ? '' : Number(v).toLocaleString('ru-RU', {maximumFractionDigits: 2}).replace(/ /g, ' ');
const parseNum = s => { s = String(s || '').replace(/[\s ]/g, '').replace(',', '.'); if (!s) return null; const n = Number(s); return isFinite(n) && n >= 0 ? n : NaN; };
const date = s => s ? new Date(s).toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit', year: '2-digit'}) : '';
const dt = s => s ? new Date(s).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) : '';
function csrf() { const m = document.cookie.match(/(?:^|;\s*)oyna_csrf=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; }
function errText(d) {
  if (!d) return 'Ошибка';
  if (typeof d === 'string') return d.slice(0, 300);
  const x = d.detail !== undefined ? d.detail : d;
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(e => (e.loc ? e.loc.slice(-1)[0] + ': ' : '') + (e.msg || '')).join('; ');
  if (x && x.msg) return x.msg;
  return JSON.stringify(x).slice(0, 300);
}
let refreshing = null;
async function refreshSession() {
  if (!refreshing) refreshing = fetch('/cabinet/refresh', {method: 'POST', headers: {'X-CSRF-Token': csrf()}, credentials: 'same-origin'})
    .then(r => r.ok).catch(() => false).finally(() => setTimeout(() => { refreshing = null; }, 0));
  return refreshing;
}
async function api(method, url, body, retry) {
  const h = {'X-CSRF-Token': csrf()};
  let b;
  if (body instanceof ArrayBuffer || body instanceof Blob) { b = body; h['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(url, {method, headers: h, body: b, credentials: 'same-origin'});
  if (r.status === 401 && !retry && !url.startsWith('/cabinet/login')) {
    if (await refreshSession()) return api(method, url, body, true);
    showLogin(); throw new Error('Сессия закончилась — войдите снова');
  }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error(errText(data)); e.status = r.status; throw e; }
  return data;
}
let toastT;
function toast(msg, err) {
  let t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.className = 'toast hidden', err ? 6000 : 3000);
}
function fail(e) { toast(e.message || String(e), true); }
function modal(html) {
  const m = $('#modal'); m.innerHTML = '<div class="modal">' + html + '</div>'; m.classList.remove('hidden');
  m.onclick = e => { if (e.target === m || e.target.closest('[data-close]')) m.classList.add('hidden'); };
}
const main = () => $('#main');
const canMarkup = () => S.session && S.session.role === 'owner';
const supName = id => { const s = (S.suppliers ? S.suppliers.suppliers : []).find(x => x.id === id); return s ? s.name : ''; };
function supplierSelect(id, cur, label) {
  const list = S.suppliers ? S.suppliers.suppliers : [];
  return '<select class="sel" id="' + id + '">' + '<option value="">' + esc(label || 'Основной прайс цеха') + '</option>' +
    list.map(s => '<option value="' + esc(s.id) + '"' + (s.id === cur ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>';
}

// ---------------- вход ----------------
let loginPhone = '';
function showLogin(step) {
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  const box = $('#lbox');
  step = step || 'phone';
  if (step === 'phone') {
    box.innerHTML = '<div class="brand" style="padding:0"><span class="logo">' + ICON + '</span><span>Eskiz Oyna</span></div>' +
      '<h1 class="h1">Кабинет цен</h1><div class="sub">Каталог, стекло, работы, поставщики и импорт прайса. Для владельца и менеджера цеха.</div>' +
      '<form id="lf" class="row" style="flex-direction:column;align-items:stretch;gap:10px"><input class="in" id="lphone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+998 90 123 45 67" value="' + esc(loginPhone) + '">' +
      '<button class="cta" type="submit">Получить код</button></form><div class="cap" id="lerr"></div>';
    $('#lf').onsubmit = async e => {
      e.preventDefault(); loginPhone = $('#lphone').value; $('#lerr').textContent = '';
      try { const r = await api('POST', '/cabinet/login/request', {phone: loginPhone}); loginPhone = r.phone; showLogin('code'); }
      catch (er) { $('#lerr').textContent = er.message; $('#lerr').className = 'cap danger'; }
    };
    setTimeout(() => $('#lphone').focus(), 50);
  } else if (step === 'code') {
    box.innerHTML = '<h1 class="h1">Код из SMS</h1><div class="sub">Отправили на ' + esc(loginPhone) + '</div>' +
      '<form id="cf" class="row" style="flex-direction:column;align-items:stretch;gap:10px"><input class="in num" id="lcode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="•••••">' +
      '<button class="cta" type="submit">Войти</button></form><div class="cap" id="lerr"></div><button class="link" id="lback" style="align-self:flex-start">Изменить номер</button>';
    $('#lback').onclick = () => showLogin('phone');
    $('#cf').onsubmit = async e => {
      e.preventDefault(); $('#lerr').textContent = '';
      try {
        const r = await api('POST', '/cabinet/login/verify', {phone: loginPhone, code: $('#lcode').value.trim()});
        if (r.choose) chooseCompany(r.companies, r.company_id); else boot();
      } catch (er) { $('#lerr').textContent = er.message; $('#lerr').className = 'cap danger'; }
    };
    setTimeout(() => $('#lcode').focus(), 50);
  }
}
function chooseCompany(list, cur) {
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  $('#lbox').innerHTML = '<h1 class="h1">Выберите цех</h1><div class="sub">Вы работаете в нескольких цехах</div>' +
    list.map(c => '<button class="co-btn" data-id="' + esc(c.id) + '"><span>' + esc(c.name) + '</span><span class="tag n">' + (c.role === 'owner' ? 'владелец' : 'менеджер') + '</span></button>').join('');
  $('#lbox').querySelectorAll('[data-id]').forEach(b => b.onclick = async () => {
    try { await api('POST', '/cabinet/session/company', {company_id: b.dataset.id}); boot(); } catch (e) { fail(e); }
  });
}
async function logout() { try { await api('POST', '/cabinet/logout'); } catch (e) {} S.session = null; showLogin(); }

// ---------------- оболочка ----------------
const SECTIONS = [['catalog', 'Каталог и цены'], ['glass', 'Стекло'], ['works', 'Работы'], ['suppliers', 'Поставщики'],
  ['import', 'Импорт Excel'], ['markup', 'Наценка'], ['versions', 'Версии цен']];
async function boot() {
  try { S.session = await api('GET', '/cabinet/session'); }
  catch (e) { if (e.status === 403) { showLogin(); $('#lerr') && ($('#lerr').textContent = e.message); } else showLogin(); return; }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  const s = S.session;
  $('#nav').innerHTML = SECTIONS.map(([k, t]) => '<a href="#' + k + '" data-sec="' + k + '">' + (NAV_ICONS[k] || '') + esc(t) + '</a>').join('');
  $('#who').innerHTML = '<div class="co">' + esc(s.company.name) + '</div><div class="ph">' + esc(s.user.phone) + ' · ' + (s.role === 'owner' ? 'владелец' : 'менеджер') + '</div>' +
    (s.companies.length > 1 ? '<select class="sel" id="cosel">' + s.companies.map(c => '<option value="' + esc(c.id) + '"' + (c.id === s.company.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '</select>' : '') +
    '<button class="soft sm" id="out">Выйти</button>';
  $('#out').onclick = logout;
  if ($('#cosel')) $('#cosel').onchange = async e => { try { await api('POST', '/cabinet/session/company', {company_id: e.target.value}); S.suppliers = null; boot(); } catch (er) { fail(er); } };
  try { [S.filters, S.suppliers] = await Promise.all([api('GET', '/oyna/company/price-filters'), api('GET', '/oyna/company/suppliers')]); } catch (e) { fail(e); }
  route();
}
function route() {
  if (!S.session) return;
  const k = (location.hash || '#catalog').slice(1);
  S.sec = SECTIONS.some(x => x[0] === k) ? k : 'catalog';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.sec === S.sec));
  const a = $('#nav a.on'); if (a && a.scrollIntoView) a.scrollIntoView({block: 'nearest', inline: 'nearest'});
  main().innerHTML = '<div class="empty">Загрузка…</div>';
  ({catalog: renderCatalog, glass: renderGlass, works: renderWorks, suppliers: renderSuppliers, import: renderImport,
    markup: renderMarkup, versions: renderVersions})[S.sec]().catch(fail);
}
window.addEventListener('hashchange', route);

// ---------------- каталог и цены ----------------
function statusTag(r) {
  if (r.status === 'supplier') return '<span class="tag info">' + esc(supName(S.cat.supplier) || 'поставщик') + '</span>';
  if (r.status === 'own') return '<span class="tag ok">своя</span>';
  if (r.status === 'demo') return '<span class="tag est">ДЕМО</span>';
  if (r.status === 'none') return '<span class="tag err">нет цены</span>';
  return '';
}
function baseCell(r) {
  if (r.base != null) return '<span class="num">' + fmt(r.base) + '</span>';
  if (r.demo != null) return '<span class="num muted">' + fmt(r.demo) + '</span> <span class="tag est">ДЕМО</span>';
  return '<span class="tag err">нет цены</span>';
}
function priceRowHtml(r) {
  const ph = r.supplier == null && S.cat.supplier ? (r.own != null ? r.own : r.base != null ? r.base : r.demo) : (r.base != null ? r.base : r.demo);
  return '<tr data-id="' + esc(r.item_id) + '" data-color="' + esc(r.color) + '">' +
    '<td class="first"><div class="art">' + esc(r.article) + ' ' + statusTag(r) + '</div><div class="meta">' + esc(r.brand + ' ' + r.series) + ' · ' + esc(r.color) + ' · <span class="num">' + esc(r.item_id) + '</span></div></td>' +
    '<td data-l="Роль"><span class="tag n">' + esc(r.role_name) + '</span>' + (r.needs_review ? ' <span class="tag est">разметка</span>' : '') + '</td>' +
    '<td data-l="Ед.">' + esc(r.unit_name) + '</td>' +
    '<td data-l="Базовая" class="r">' + baseCell(r) + '</td>' +
    '<td data-l="' + (S.cat.supplier ? 'Цена поставщика' : 'Цена цеха') + '" class="r"><input class="pin" inputmode="decimal" value="' + esc(fmt(r.value)) + '" placeholder="' + esc(fmt(ph)) + '" data-orig="' + esc(fmt(r.value)) + '" aria-label="Цена"></td>' +
    '<td data-l="Обновлено" class="cap">' + esc(date(r.updated)) + '</td>' +
    '<td data-l="" class="r"><button class="link" data-hist>История</button></td></tr>';
}
async function renderCatalog() {
  const f = S.filters || {systems: [], roles: [], colors: [], categories: [], role_names: {}};
  const c = S.cat;
  const brands = {};
  f.systems.forEach(s => (brands[s.brand] = brands[s.brand] || []).push(s));
  main().innerHTML =
    '<div class="top"><h1 class="h1">Каталог и цены</h1><span class="grow"></span><a class="soft" href="#import">Импорт CSV / Excel</a><a class="soft" href="#versions">Версии цен</a></div>' +
    '<div class="row"><label class="f" style="flex:1 1 220px">Прайс' + supplierSelect('csup', c.supplier) + '</label>' +
    '<label class="f" style="flex:2 1 300px">Поиск<input class="in search" id="cq" placeholder="Название, артикул или код it00001" value="' + esc(c.q) + '"></label></div>' +
    '<div class="row"><select class="sel" id="ccat"><option value="">Все категории</option>' + f.categories.map(x => '<option value="' + x.code + '"' + (c.category === x.code ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select>' +
    '<select class="sel" id="csys" style="max-width:280px"><option value="">Все системы</option>' + Object.keys(brands).map(b => '<optgroup label="' + esc(b) + '">' + brands[b].map(s => '<option value="' + esc(s.code) + '"' + (c.system === s.code ? ' selected' : '') + '>' + esc(s.series) + ' · ' + s.items + '</option>').join('') + '</optgroup>').join('') + '</select>' +
    '<select class="sel" id="crole"><option value="">Все роли</option>' + f.roles.map(r => '<option value="' + esc(r) + '"' + (c.role === r ? ' selected' : '') + '>' + esc(f.role_names[r] || r) + '</option>').join('') + '</select>' +
    '<select class="sel" id="ccolor"><option value="">Все цвета</option>' + f.colors.map(r => '<option' + (c.color === r ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select></div>' +
    '<div class="chips" id="cchips"></div>' +
    '<div class="sheet"><table class="cards" id="ctab"><thead><tr><th>Позиция</th><th>Роль</th><th>Ед.</th><th class="r">Базовая</th><th class="r" id="cpcol">' + (c.supplier ? 'Цена поставщика' : 'Цена цеха') + '</th><th>Обновлено</th><th></th></tr></thead><tbody></tbody></table><div id="cmore"></div></div>' +
    '<div class="cap" style="padding:0 6px">Пустое поле — действует базовая цена (серым). Enter или уход из поля сохраняет цену новой версией; очистите поле, чтобы убрать свою цену. ДЕМО-цены видны, но в КП идут с меткой «ДЕМО».</div>';
  let t;
  $('#cq').oninput = e => { clearTimeout(t); t = setTimeout(() => { c.q = e.target.value; loadCatalog(); }, 300); };
  $('#csup').onchange = e => { c.supplier = e.target.value; $('#cpcol').textContent = c.supplier ? 'Цена поставщика' : 'Цена цеха'; loadCatalog(); };
  [['ccat', 'category'], ['csys', 'system'], ['crole', 'role'], ['ccolor', 'color']].forEach(([id, k]) => $('#' + id).onchange = e => { c[k] = e.target.value; loadCatalog(); });
  const tb = $('#ctab tbody');
  tb.addEventListener('keydown', e => {
    if (!e.target.classList.contains('pin')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') { e.target.value = e.target.dataset.orig; e.target.blur(); }
  });
  tb.addEventListener('focusout', e => { if (e.target.classList.contains('pin')) savePrice(e.target); });
  tb.addEventListener('click', e => { const b = e.target.closest('[data-hist]'); if (b) { const tr = b.closest('tr'); showHistory(tr.dataset.id, tr.dataset.color); } });
  await loadCatalog();
}
async function loadCatalog(append) {
  const c = S.cat;
  if (!append) c.offset = 0;
  const p = new URLSearchParams();
  ['q', 'category', 'system', 'role', 'color', 'flag'].forEach(k => c[k] && p.set(k, c[k]));
  if (c.supplier) p.set('supplier_id', c.supplier);
  p.set('offset', c.offset); p.set('limit', 100);
  const d = await api('GET', '/oyna/company/price-list?' + p);
  if (S.sec !== 'catalog') return;
  const n = d.counts;
  const chip = (k, t, cls) => '<button class="chip ' + (cls || '') + (c.flag === k ? ' on' : '') + '" data-flag="' + k + '">' + t + ' <span class="n">' + n[k === '' ? 'all' : k] + '</span></button>';
  $('#cchips').innerHTML = chip('', 'Все') + chip('missing', 'без цены', 'red') + chip('demo', 'ДЕМО') + chip('own', S.cat.supplier ? 'есть у поставщика' : 'свои цены') + chip('review', 'нужна разметка');
  $('#cchips').querySelectorAll('[data-flag]').forEach(b => b.onclick = () => { c.flag = b.dataset.flag; loadCatalog(); });
  const tb = $('#ctab tbody');
  const html = d.rows.map(priceRowHtml).join('');
  if (append) tb.insertAdjacentHTML('beforeend', html); else tb.innerHTML = html || '<tr><td colspan="7" class="empty">Ничего не найдено</td></tr>';
  const shown = c.offset + d.rows.length;
  $('#cmore').innerHTML = '<div class="more"><span class="cap">Показано ' + shown + ' из ' + d.total + '</span>' + (shown < d.total ? '&nbsp;&nbsp;<button class="soft sm" id="cmoreb">Показать ещё</button>' : '') + '</div>';
  if ($('#cmoreb')) $('#cmoreb').onclick = () => { c.offset = shown; loadCatalog(true).catch(fail); };
}
async function savePrice(inp) {
  if (inp.value.trim() === inp.dataset.orig.trim()) return;
  const v = parseNum(inp.value);
  if (Number.isNaN(v)) { inp.classList.add('err'); toast('Цена — число, например 312 000', true); return; }
  const tr = inp.closest('tr');
  inp.classList.remove('err', 'saved'); inp.classList.add('saving');
  try {
    const r = await api('PUT', '/oyna/company/prices', [{item_id: tr.dataset.id, color: tr.dataset.color, price_sum: v, supplier_id: S.cat.supplier || null}]);
    const row = r.rows && r.rows[0];
    if (row) { const tmp = document.createElement('tbody'); tmp.innerHTML = priceRowHtml(row); const nt = tmp.firstElementChild; tr.replaceWith(nt); const ni = $('.pin', nt); ni.classList.add('saved'); setTimeout(() => ni.classList.remove('saved'), 1500); }
    toast(v == null ? 'Своя цена убрана — действует базовая' : 'Цена сохранена');
  } catch (e) { inp.classList.remove('saving'); inp.classList.add('err'); fail(e); }
}
async function showHistory(id, color) {
  const d = await api('GET', '/oyna/company/prices/history?item_id=' + encodeURIComponent(id) + '&color=' + encodeURIComponent(color));
  modal('<h3>' + esc(d.article) + '</h3><div class="cap">' + esc(id) + ' · ' + esc(color) + '</div><div style="margin-top:10px">' +
    d.history.map(h => '<div class="hl"><div><div>' + esc(h.kind_name) + (h.supplier ? ' · ' + esc(h.supplier) : '') + (h.reverted ? ' <span class="tag err">отменён</span>' : '') + '</div><div class="cap">' + esc(h.kind === 'base' ? date(h.at) : dt(h.at)) + (h.by ? ' · ' + esc(h.by) : '') + (h.note && h.kind !== 'base' ? ' · ' + esc(h.note) : '') + '</div></div>' +
      '<div class="num" style="font-weight:600;white-space:nowrap">' + (h.price_sum != null ? fmt(h.price_sum) : h.kind === 'base' && h.demo_price_sum != null ? fmt(h.demo_price_sum) + ' <span class="tag est">ДЕМО</span>' : h.kind === 'base' ? '<span class="tag err">нет цены</span>' : '<span class="muted">убрана</span>') + '</div></div>').join('') +
    '</div><div style="margin-top:14px;text-align:right"><button class="soft" data-close>Закрыть</button></div>');
}

// ---------------- стекло ----------------
const GLASS_KEYS = {base_single_chamber: 'Однокамерный 4-x-4 (база)', extra_chamber: 'Ещё одна камера', single_pane_4mm: 'Одинарное стекло 4 мм',
  pane_extra_per_mm: 'Стекло толще 4 мм, за мм', low_e: 'Энергосберегающее (i)', tempered: 'Закалённое (t)', tinted: 'Тонированное',
  matte: 'Матовое', triplex: 'Триплекс', argon: 'Аргон в камере', min_area_m2: 'Минимальная площадь, м²', shaped_extra_pct: 'Фигурное стекло, %',
  spacer_extra_per_mm: 'Рамка шире 12 мм, за мм'};
let glassSup = '';
async function renderGlass() {
  const d = await api('GET', '/oyna/company/glass-list' + (glassSup ? '?supplier_id=' + encodeURIComponent(glassSup) : ''));
  if (S.sec !== 'glass') return;
  const gRow = g => '<tr data-code="' + esc(g.code) + '"><td class="first"><div class="art">' + esc(g.formula || g.code) + '</div><div class="meta">' + esc(g.code) + (g.thickness_mm ? ' · ' + g.thickness_mm + ' мм' : '') + '</div></td>' +
    '<td data-l="Базовая" class="r">' + (g.base != null ? '<span class="num">' + fmt(g.base) + '</span> ' + (g.base_status === 'найдено' ? '' : '<span class="tag est">' + esc(g.base_status === 'оценка' ? 'ДЕМО' : g.base_status || '') + '</span>') : '<span class="tag err">нет цены</span>') + '</td>' +
    '<td data-l="' + (glassSup ? 'Цена поставщика' : 'Цена цеха') + '" class="r"><input class="pin" inputmode="decimal" value="' + esc(fmt(g.value)) + '" data-orig="' + esc(fmt(g.value)) + '" placeholder="' + esc(fmt(g.base)) + '"></td></tr>';
  main().innerHTML = '<div class="top"><h1 class="h1">Стекло</h1><span class="grow"></span><label class="f">Прайс' + supplierSelect('gsup', glassSup, 'Основной прайс цеха') + '</label></div>' +
    '<div class="sheet"><div class="pad" style="padding-bottom:0"><b>Стеклопакеты</b><div class="cap">Цена за м². Пустое поле — базовая цена (серым).</div></div><table class="cards" id="gtab"><thead><tr><th>Формула</th><th class="r">Базовая, сум/м²</th><th class="r">' + (glassSup ? 'Поставщик' : 'Цена цеха') + ', сум/м²</th></tr></thead><tbody>' +
    d.presets.map(gRow).join('') + d.custom.map(g => gRow({code: g.code, formula: g.code, value: g.value})).join('') + '</tbody></table>' +
    '<form class="pad row" id="gadd"><input class="in" id="gf" placeholder="Своя формула, напр. 4i-16-4" style="flex:2 1 200px"><input class="in num" id="gp" inputmode="decimal" placeholder="сум/м²" style="flex:1 1 120px"><button class="soft" type="submit">Добавить</button></form></div>' +
    '<div class="sheet"><div class="pad" style="padding-bottom:0"><b>Формула стеклопакета</b><div class="cap">Надбавки для формул без своей цены: сумма за м², кроме площади и процента.</div></div>' +
    '<table class="cards" id="ftab"><thead><tr><th>Надбавка</th><th class="r">Базовая</th><th class="r">Цена цеха</th></tr></thead><tbody>' +
    d.pricing.map(p => '<tr data-key="' + esc(p.key) + '"><td class="first"><div class="art">' + esc(GLASS_KEYS[p.key] || p.key) + '</div><div class="meta">' + esc(p.note) + '</div></td><td data-l="Базовая" class="r num">' + fmt(p.base) + (p.status && p.status !== 'найдено' ? ' <span class="tag est">' + esc(p.status === 'оценка' ? 'ДЕМО' : p.status) + '</span>' : '') + '</td>' +
      '<td data-l="Цена цеха" class="r"><input class="pin fpin" inputmode="decimal" value="' + esc(fmt(p.own)) + '" placeholder="' + esc(fmt(p.base)) + '"></td></tr>').join('') +
    '</tbody></table><div class="pad row"><span class="grow"></span><button class="cta" id="fsave">Сохранить формулу</button></div></div>';
  $('#gsup').onchange = e => { glassSup = e.target.value; renderGlass().catch(fail); };
  const tb = $('#gtab tbody');
  tb.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('pin')) { e.preventDefault(); e.target.blur(); } });
  tb.addEventListener('focusout', async e => {
    const inp = e.target; if (!inp.classList.contains('pin') || inp.value.trim() === inp.dataset.orig.trim()) return;
    const v = parseNum(inp.value); if (Number.isNaN(v)) { inp.classList.add('err'); return; }
    inp.classList.add('saving');
    try { await saveGlass(inp.closest('tr').dataset.code, v); inp.dataset.orig = inp.value; inp.classList.remove('saving', 'err'); inp.classList.add('saved'); toast('Цена стекла сохранена'); }
    catch (er) { inp.classList.remove('saving'); inp.classList.add('err'); fail(er); }
  });
  $('#gadd').onsubmit = async e => {
    e.preventDefault(); const v = parseNum($('#gp').value);
    if (!$('#gf').value.trim() || v == null || Number.isNaN(v)) { toast('Нужны формула и цена', true); return; }
    try { await saveGlass($('#gf').value.trim(), v); toast('Формула добавлена'); renderGlass().catch(fail); } catch (er) { fail(er); }
  };
  $('#fsave').onclick = async () => {
    const body = {};
    for (const tr of document.querySelectorAll('#ftab tr[data-key]')) {
      const v = parseNum($('.fpin', tr).value); if (Number.isNaN(v)) { toast('Надбавка — число', true); return; }
      if (v != null) body[tr.dataset.key] = v;
    }
    try { await api('PUT', '/oyna/company/glass-pricing', body); toast('Формула сохранена'); } catch (er) { fail(er); }
  };
}
function saveGlass(code, v) {
  return api('PUT', '/oyna/company/glass-prices' + (glassSup ? '?supplier_id=' + encodeURIComponent(glassSup) : ''), {[code]: v});
}

// ---------------- работы ----------------
const UNITS = {m2: 'м²', m: 'м', pcs: 'шт', kg: 'кг'};
async function renderWorks() {
  const d = await api('GET', '/oyna/company');
  if (S.sec !== 'works') return;
  const w = d.works;
  main().innerHTML = '<div class="top"><h1 class="h1">Работы</h1></div>' +
    '<div class="sheet"><table class="cards" id="wtab"><thead><tr><th>Работа</th><th>Ед.</th><th class="r">ДЕМО / справочно</th><th class="r">Ставка цеха</th></tr></thead><tbody>' +
    Object.keys(w).map(k => { const x = w[k]; return '<tr data-code="' + esc(k) + '"><td class="first"><div class="art">' + esc(x.name) + (x.set ? '' : ' <span class="tag est">' + (x.demo_price_sum != null ? 'ДЕМО' : 'нет ставки') + '</span>') + '</div><div class="meta">' + esc(k) + '</div></td>' +
      '<td data-l="Ед.">' + esc(UNITS[x.unit] || x.unit) + '</td><td data-l="ДЕМО / справочно" class="r num muted">' + fmt(x.demo_price_sum) + (x.ref_price_sum ? ' / ' + fmt(x.ref_price_sum) : '') + '</td>' +
      '<td data-l="Ставка цеха" class="r"><input class="pin" inputmode="decimal" value="' + esc(fmt(x.price_sum)) + '" data-orig="' + esc(fmt(x.price_sum)) + '" placeholder="' + esc(fmt(x.demo_price_sum)) + '"></td></tr>'; }).join('') +
    '</tbody></table></div><div class="cap" style="padding:0 6px">Пустое поле — ставки нет: в ДЕМО-цехе берётся ДЕМО, в боевом — «нет цены».</div>';
  const tb = $('#wtab tbody');
  tb.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('pin')) { e.preventDefault(); e.target.blur(); } });
  tb.addEventListener('focusout', async e => {
    const inp = e.target; if (!inp.classList.contains('pin') || inp.value.trim() === inp.dataset.orig.trim()) return;
    const v = parseNum(inp.value); if (Number.isNaN(v)) { inp.classList.add('err'); return; }
    inp.classList.add('saving');
    try { await api('PUT', '/oyna/company/works', {[inp.closest('tr').dataset.code]: v}); inp.dataset.orig = inp.value; inp.classList.remove('saving', 'err'); inp.classList.add('saved'); toast('Ставка сохранена'); }
    catch (er) { inp.classList.remove('saving'); inp.classList.add('err'); fail(er); }
  });
}

// ---------------- поставщики ----------------
async function renderSuppliers() {
  S.suppliers = await api('GET', '/oyna/company/suppliers');
  if (S.sec !== 'suppliers') return;
  const d = S.suppliers;
  const catName = Object.fromEntries(d.categories.map(c => [c.code, c.name]));
  main().innerHTML = '<div class="top"><h1 class="h1">Поставщики</h1></div>' +
    '<div class="sheet pad"><b>Основной поставщик по категориям</b><div class="cap" style="margin-bottom:10px">Его цены — поверх своих цен цеха. В позиции можно выбрать другого поставщика (setup.suppliers).</div><div class="mapg">' +
    d.categories.map(c => '<label class="f">' + esc(c.name) + supplierSelect('def_' + c.code, d.defaults[c.code], 'Свои цены цеха') + '</label>').join('') + '</div></div>' +
    '<div class="grid2">' + (d.suppliers.length ? d.suppliers.map(s => '<div class="card" data-id="' + esc(s.id) + '"><div class="t">' + esc(s.name) + '</div><div class="cap">' + esc(s.note || '') + '</div>' +
      '<div class="cap">Цен: ' + s.prices + ' · стекло: ' + s.glass_prices + (s.default_for.length ? '<br>Основной: ' + s.default_for.map(k => esc(catName[k])).join(', ') : '') + '</div>' +
      '<div class="row"><a class="link" href="#catalog" data-open>Цены</a><span class="grow"></span><button class="link" data-ren>Изменить</button><button class="link danger" data-del>Удалить</button></div></div>').join('') : '<div class="card"><div class="sub">Поставщиков пока нет. Цены цеха — один основной прайс.</div></div>') + '</div>' +
    '<form class="sheet pad row" id="sadd"><input class="in" id="sname" placeholder="Название поставщика" style="flex:2 1 200px" maxlength="120"><input class="in" id="snote" placeholder="Заметка (телефон, условия)" style="flex:2 1 200px" maxlength="500"><button class="cta" type="submit">Добавить</button></form>';
  d.categories.forEach(c => $('#def_' + c.code).onchange = async e => {
    try { S.suppliers = await api('PUT', '/oyna/company/suppliers/defaults', {[c.code]: e.target.value || null}); toast('Основной поставщик: ' + c.name); renderSuppliers().catch(fail); } catch (er) { fail(er); }
  });
  $('#sadd').onsubmit = async e => {
    e.preventDefault(); const name = $('#sname').value.trim(); if (!name) return;
    try { await api('POST', '/oyna/company/suppliers', {name, note: $('#snote').value.trim() || null}); toast('Поставщик добавлен'); renderSuppliers().catch(fail); } catch (er) { fail(er); }
  };
  main().querySelectorAll('.card[data-id]').forEach(cd => {
    const id = cd.dataset.id;
    $('[data-open]', cd).onclick = () => { S.cat.supplier = id; S.cat.flag = 'own'; };
    $('[data-ren]', cd).onclick = async () => {
      const s = d.suppliers.find(x => x.id === id); const name = prompt('Название поставщика', s.name); if (name == null || !name.trim()) return;
      const note = prompt('Заметка', s.note || '');
      try { await api('PATCH', '/oyna/company/suppliers/' + id, {name: name.trim(), note: note == null ? s.note : note}); renderSuppliers().catch(fail); } catch (er) { fail(er); }
    };
    $('[data-del]', cd).onclick = async () => {
      if (!confirm('Удалить поставщика вместе с его ценами?')) return;
      try { await api('DELETE', '/oyna/company/suppliers/' + id); if (S.cat.supplier === id) S.cat.supplier = ''; toast('Поставщик удалён'); renderSuppliers().catch(fail); } catch (er) { fail(er); }
    };
  });
}

// ---------------- импорт ----------------
const IMP = {file: null, parsed: null, mapping: {}, currency: 'UZS', color: 'Белый', system: '', supplier: '', preview: null, tab: 'all'};
const MAP_FIELDS = [['article', 'Артикул / код'], ['name', 'Название'], ['price', 'Цена *'], ['currency', 'Валюта'], ['unit', 'Единица'], ['color', 'Цвет']];
const ST = {match: ['изменится', 'ok'], same: ['без изменений', 'n'], not_found: ['не найдено', 'err'], no_color: ['нет цвета', 'est'],
  bad_price: ['цена не число', 'err'], unit_mismatch: ['единица', 'est'], no_rate: ['нет курса', 'err'], bad_currency: ['валюта', 'err'], empty: ['пустая', 'n']};
async function renderImport() {
  const v = await api('GET', '/oyna/company/price-versions?limit=5');
  if (S.sec !== 'import') return;
  const last = v.versions.find(x => x.id === v.undo_import);
  const step = IMP.preview ? 3 : IMP.parsed ? 2 : 1;
  let h = '<div class="top"><h1 class="h1">Импорт прайса</h1><span class="grow"></span><a class="soft" href="#versions">Версии цен</a></div>' +
    '<div class="steps"><i class="d"></i><i class="' + (step > 1 ? 'd' : '') + '"></i><i class="' + (step > 2 ? 'd' : '') + '"></i></div>';
  if (last) h += '<div class="ban info"><div><b>Последний импорт</b><div>' + esc(last.note || '') + ' · ' + esc(dt(last.at)) + '</div></div><span class="grow"></span><button class="soft sm" id="undo">Отменить импорт</button></div>';
  h += '<div class="sheet pad row"><label class="f" style="flex:1 1 220px">Чей прайс' + supplierSelect('isup', IMP.supplier) + '</label>' +
    '<label class="f" style="flex:2 1 260px">Файл xlsx или csv<input class="in" type="file" id="ifile" accept=".xlsx,.xlsm,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>' +
    '<button class="cta" id="iload" style="align-self:flex-end">Загрузить</button></div>';
  if (IMP.parsed) {
    const p = IMP.parsed;
    const opt = (k) => '<select class="sel" data-map="' + k + '"><option value="">—</option>' + p.columns.map((c, j) => '<option value="' + j + '"' + (IMP.mapping[k] === j ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>';
    const sysOpts = (S.filters ? S.filters.systems : []).map(s => '<option value="' + esc(s.code) + '"' + (IMP.system === s.code ? ' selected' : '') + '>' + esc(s.brand + ' ' + s.series) + '</option>').join('');
    h += '<div class="sheet pad" style="display:flex;flex-direction:column;gap:12px"><div><b>Сопоставьте колонки</b> <span class="cap">' + esc(p.filename || '') + (p.sheet ? ' · лист «' + esc(p.sheet) + '»' : '') + ' · строк: ' + p.total + '</span></div>' +
      '<div class="mapg">' + MAP_FIELDS.map(([k, t]) => '<label class="f">' + t + opt(k) + '</label>').join('') + '</div>' +
      '<div class="mapg"><label class="f">Валюта по умолчанию<span class="seg" id="icur"><button type="button" data-v="UZS" class="' + (IMP.currency === 'UZS' ? 'on' : '') + '">сум</button><button type="button" data-v="USD" class="' + (IMP.currency === 'USD' ? 'on' : '') + '">USD</button></span></label>' +
      '<label class="f">Цвет, если нет колонки<select class="sel" id="icolor">' + p.colors.map(c => '<option' + (IMP.color === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></label>' +
      '<label class="f">Искать в серии<select class="sel" id="isys"><option value="">во всех сериях</option>' + sysOpts + '</select></label></div>' +
      '<div class="scroll"><table><thead><tr>' + p.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' +
      p.rows.slice(0, 5).map(r => '<tr>' + r.map(x => '<td>' + esc(x) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' +
      '<div class="row"><span class="grow"></span><button class="cta" id="iprev">Предпросмотр</button></div></div>';
  }
  if (IMP.preview) {
    const s = IMP.preview.summary;
    const rows = IMP.preview.rows.filter(r => IMP.tab === 'all' || (IMP.tab === 'match' ? r.status === 'match' : IMP.tab === 'same' ? r.status === 'same' : !['match', 'same'].includes(r.status)));
    const bad = s.rows - (s.match || 0) - (s.same || 0);
    h += '<div class="sheet"><div class="pad" style="display:flex;flex-direction:column;gap:10px"><b>Предпросмотр</b>' +
      '<div class="chips"><span class="chip">по артикулу <span class="n">' + s.by_article + '</span></span><span class="chip">по названию <span class="n">' + s.by_name + '</span></span>' +
      '<span class="chip" style="color:var(--green)">изменится цен <span class="n">' + s.items + '</span></span></div>' +
      '<div class="seg" id="itab">' + [['all', 'Все ' + s.rows], ['match', 'Изменятся ' + (s.match || 0)], ['same', 'Без изменений ' + (s.same || 0)], ['bad', 'Не найдено и ошибки ' + bad]].map(([k, t]) => '<button type="button" data-t="' + k + '" class="' + (IMP.tab === k ? 'on' : '') + '">' + t + '</button>').join('') + '</div></div>' +
      '<table class="cards"><thead><tr><th>#</th><th>Строка файла</th><th>Позиция каталога</th><th class="r">Было</th><th class="r">Станет</th><th>Итог</th></tr></thead><tbody>' +
      rows.slice(0, 300).map(r => { const it = r.items[0]; const st = ST[r.status] || [r.status, 'n'];
        return '<tr><td data-l="#" class="cap">' + r.n + '</td><td class="first"><div class="art">' + esc(r.article || r.name) + '</div><div class="meta">' + esc(r.article && r.name ? r.name : '') + ' · ' + esc(r.price_in) + (r.currency && r.currency !== 'UZS' ? ' ' + esc(r.currency) : '') + '</div></td>' +
          '<td data-l="Позиция">' + (it ? esc(it.article) + '<div class="meta">' + esc(it.color) + ' · ' + esc(it.item_id) + (r.by === 'name' ? ' · по названию' : '') + (r.items.length > 1 ? ' · ещё ' + (r.items.length - 1) : '') + '</div>' : '<span class="muted">—</span>') + '</td>' +
          '<td data-l="Было" class="r num">' + (it ? fmt(it.old) : '') + '</td><td data-l="Станет" class="r num" style="font-weight:600">' + (it ? fmt(it.new) : '') + '</td>' +
          '<td data-l="Итог"><span class="tag ' + st[1] + '">' + esc(st[0]) + '</span> <span class="cap">' + esc(r.msg || '') + '</span></td></tr>'; }).join('') +
      (rows.length > 300 ? '<tr><td colspan="6" class="cap">… и ещё ' + (rows.length - 300) + '</td></tr>' : '') + '</tbody></table>' +
      '<div class="pad row"><span class="cap">Версия: ' + esc(IMP.supplier ? supName(IMP.supplier) : 'основной прайс цеха') + '</span><span class="grow"></span><button class="cta" id="iapply"' + (s.items ? '' : ' disabled') + '>Применить · ' + s.items + ' цен</button></div></div>';
  }
  main().innerHTML = h;
  if ($('#undo')) $('#undo').onclick = async () => { if (!confirm('Отменить последний импорт? Его цены перестанут действовать.')) return; try { const r = await api('POST', '/oyna/company/price-versions/undo-import'); toast('Импорт отменён: ' + r.items + ' цен'); renderImport().catch(fail); } catch (e) { fail(e); } };
  $('#isup').onchange = e => { IMP.supplier = e.target.value; IMP.preview = null; renderImport().catch(fail); };
  $('#iload').onclick = async () => {
    const f = $('#ifile').files[0]; if (!f) { toast('Выберите файл', true); return; }
    try {
      const buf = await f.arrayBuffer();
      IMP.parsed = await api('POST', '/oyna/company/price-import/parse?filename=' + encodeURIComponent(f.name), buf);
      IMP.mapping = Object.assign({}, IMP.parsed.mapping); IMP.preview = null; IMP.tab = 'all';
      renderImport().catch(fail);
    } catch (e) { fail(e); }
  };
  main().querySelectorAll('[data-map]').forEach(s => s.onchange = e => { IMP.mapping[s.dataset.map] = e.target.value === '' ? null : Number(e.target.value); });
  if ($('#icur')) $('#icur').querySelectorAll('button').forEach(b => b.onclick = () => { IMP.currency = b.dataset.v; $('#icur').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
  if ($('#icolor')) $('#icolor').onchange = e => IMP.color = e.target.value;
  if ($('#isys')) $('#isys').onchange = e => IMP.system = e.target.value;
  if ($('#iprev')) $('#iprev').onclick = async () => {
    if (IMP.mapping.price == null) { toast('Выберите колонку с ценой', true); return; }
    if (IMP.mapping.article == null && IMP.mapping.name == null) { toast('Нужна колонка артикула или названия', true); return; }
    try { IMP.preview = await api('POST', '/oyna/company/price-import/preview', importBody()); IMP.tab = 'all'; renderImport().catch(fail); } catch (e) { fail(e); }
  };
  if ($('#itab')) $('#itab').querySelectorAll('button').forEach(b => b.onclick = () => { IMP.tab = b.dataset.t; renderImport().catch(fail); });
  if ($('#iapply')) $('#iapply').onclick = async () => {
    try { const r = await api('POST', '/oyna/company/price-import/apply', importBody()); toast(r.note); IMP.parsed = null; IMP.preview = null; renderImport().catch(fail); } catch (e) { fail(e); }
  };
}
function importBody() {
  const m = {}; MAP_FIELDS.forEach(([k]) => { if (IMP.mapping[k] != null) m[k] = IMP.mapping[k]; });
  return {rows: IMP.parsed.rows, mapping: m, currency: IMP.currency, color: IMP.color || null, system: IMP.system || null,
    supplier_id: IMP.supplier || null, filename: IMP.parsed.filename};
}

// ---------------- наценка ----------------
const GROUPS = [['profile', 'Профиль', 'профиль, штапик, армирование, уплотнитель, ламинация'], ['glass', 'Стекло', 'стеклопакеты, декор стекла, раскладка'],
  ['fittings', 'Фурнитура', 'петли, ручки, приводы, замки'], ['works', 'Работы', 'монтаж, демонтаж, откосы'], ['other', 'Прочее', 'подоконники, отливы, соединители, расходники']];
const KINDS = [['percent', 'На себестоимость, %'], ['margin', 'Доля маржи в цене, %'], ['per_m2', 'За м², сум']];
async function renderMarkup() {
  if (!canMarkup()) { main().innerHTML = '<div class="top"><h1 class="h1">Наценка</h1></div><div class="ban info">Наценку видит и меняет только владелец цеха.</div>'; return; }
  const d = await api('GET', '/oyna/company');
  if (S.sec !== 'markup') return;
  const co = d.company;
  const st = {kind: co.markup_kind, value: Number(co.markup_value), groups: co.markup_groups || null};
  const draw = () => {
    const per = st.kind === 'per_m2', byGroup = !!st.groups && !per;
    main().innerHTML = '<div class="top"><h1 class="h1">Наценка</h1></div>' +
      '<div class="sheet pad" style="display:flex;flex-direction:column;gap:14px">' +
      '<div class="seg" id="mkind">' + KINDS.map(([k, t]) => '<button type="button" data-k="' + k + '" class="' + (st.kind === k ? 'on' : '') + '">' + t + '</button>').join('') + '</div>' +
      '<div class="seg" id="mmode"><button type="button" data-m="all" class="' + (byGroup ? '' : 'on') + '">Общая</button><button type="button" data-m="groups" class="' + (byGroup ? 'on' : '') + '"' + (per ? ' disabled title="За м² — только общая"' : '') + '>По группам</button></div>' +
      '<label class="f" style="max-width:260px">' + (byGroup ? 'Для групп без своей наценки' : 'Наценка') + '<input class="in num" id="mval" inputmode="decimal" value="' + esc(fmt(st.value)) + '"></label>' +
      (byGroup ? '<div class="mapg">' + GROUPS.map(([k, t, h]) => '<label class="f">' + t + ', %<input class="in num" data-g="' + k + '" inputmode="decimal" value="' + esc(st.groups[k] != null ? fmt(st.groups[k]) : '') + '" placeholder="' + esc(fmt(st.value)) + '"><span class="cap">' + h + '</span></label>').join('') + '</div>' : '') +
      '<div class="cap" id="mex"></div><div class="row"><span class="grow"></span><button class="cta" id="msave">Сохранить</button></div></div>' +
      '<div class="cap" style="padding:0 6px">Группа строки расчёта — по роли позиции. Себестоимость 1 000 000 при 30 %: «на себестоимость» → 1 300 000, «доля маржи» → 1 428 571.</div>';
    $('#mkind').querySelectorAll('button').forEach(b => b.onclick = () => { st.kind = b.dataset.k; draw(); });
    $('#mmode').querySelectorAll('button').forEach(b => b.onclick = () => { if (b.disabled) return; st.groups = b.dataset.m === 'groups' ? (st.groups || {}) : null; draw(); });
    const ex = () => { const v = parseNum($('#mval').value) || 0; const c = 1000000; const p = st.kind === 'percent' ? c * (1 + v / 100) : st.kind === 'margin' ? c / (1 - Math.min(v, 95) / 100) : null;
      $('#mex').textContent = p ? 'Пример: себестоимость 1 000 000 → цена ' + fmt(Math.round(p)) : 'Пример: окно 1,8 м² → + ' + fmt(Math.round(v * 1.8)) + ' сум'; };
    $('#mval').oninput = ex; ex();
    $('#msave').onclick = async () => {
      const v = parseNum($('#mval').value); if (v == null || Number.isNaN(v)) { toast('Наценка — число', true); return; }
      let groups = null;
      if (st.groups && st.kind !== 'per_m2') { groups = {}; for (const i of main().querySelectorAll('[data-g]')) { const g = parseNum(i.value); if (Number.isNaN(g)) { toast('Наценка группы — число', true); return; } if (g != null) groups[i.dataset.g] = g; } }
      try { const r = await api('PATCH', '/oyna/company', {markup_kind: st.kind, markup_value: v, markup_groups: groups}); st.value = Number(r.company.markup_value); st.groups = r.company.markup_groups || (groups ? {} : null); toast('Наценка сохранена'); draw(); } catch (e) { fail(e); }
    };
  };
  draw();
}

// ---------------- версии цен ----------------
async function renderVersions() {
  const d = await api('GET', '/oyna/company/price-versions?limit=100');
  if (S.sec !== 'versions') return;
  main().innerHTML = '<div class="top"><h1 class="h1">Версии цен</h1><span class="grow"></span><a class="soft" href="#import">Импорт</a></div>' +
    '<div class="sheet">' + (d.versions.length ? '<table class="cards"><thead><tr><th>Когда</th><th>Что</th><th>Прайс</th><th class="r">Цен</th><th>Кто</th><th></th></tr></thead><tbody>' +
      d.versions.map(v => '<tr><td class="first"><div class="art">' + esc(dt(v.at)) + '</div><div class="meta">' + esc(v.note || '') + '</div></td>' +
        '<td data-l="Что"><span class="tag ' + (v.kind === 'import' ? 'info' : 'n') + '">' + esc(v.kind_name) + '</span>' + (v.reverted_at ? ' <span class="tag err">отменён</span>' : '') + '</td>' +
        '<td data-l="Прайс">' + esc(v.supplier || 'основной') + '</td><td data-l="Цен" class="r num">' + v.items + '</td><td data-l="Кто" class="cap">' + esc(v.by || '') + '</td>' +
        '<td class="r" data-l="">' + (v.id === d.undo_import ? '<button class="soft sm" id="vundo">Отменить импорт</button>' : '') + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="empty">Версий пока нет — правка цены в каталоге или импорт файла создают версию</div>') + '</div>';
  if ($('#vundo')) $('#vundo').onclick = async () => { if (!confirm('Отменить последний импорт?')) return; try { const r = await api('POST', '/oyna/company/price-versions/undo-import'); toast('Импорт отменён: ' + r.items + ' цен'); renderVersions().catch(fail); } catch (e) { fail(e); } };
}

boot();
"""

ICON = ('<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
        'stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="1.5"/><path d="M12 3.5v17M4 12h16"/></svg>')


def _svg(d: str) -> str:
    return ('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
            f'stroke-linejoin="round" aria-hidden="true">{d}</svg>')


NAV_ICONS = {
    "catalog": _svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
    "glass": _svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 16l8-8"/>'),
    "works": _svg('<path d="M14 6l4 4-8 8H6v-4z"/>'),
    "suppliers": _svg('<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.5"/><circle cx="17" cy="17.5" r="1.5"/>'),
    "import": _svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    "markup": _svg('<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>'),
    "versions": _svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),
}


def page() -> str:
    import json
    consts = f"const ICON = {json.dumps(ICON)};\nconst NAV_ICONS = {json.dumps(NAV_ICONS)};\n"
    return ('<!doctype html><html lang="ru"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<meta name="robots" content="noindex"><meta name="theme-color" content="#F4F3EF">'
            f'<title>Кабинет цен — Eskiz Oyna</title>{FONTS}<style>{CSS}</style></head><body>'
            '<div id="login" class="login hidden"><div class="lcard" id="lbox"></div></div>'
            f'<div id="app" class="web hidden"><aside class="side"><div class="brand"><span class="logo">{ICON}</span><span>Eskiz Oyna</span></div>'
            '<nav class="nav" id="nav"></nav><div class="grow"></div><div class="who" id="who"></div></aside>'
            '<main class="main" id="main"></main></div>'
            '<div id="toast" class="toast hidden" role="status" aria-live="polite"></div><div id="modal" class="scrim hidden"></div>'
            f'<script>{consts}{JS}</script></body></html>')
