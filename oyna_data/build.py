import csv, json, re, collections
import sys; src=sys.argv[1] if len(sys.argv)>1 else 'romchi_raw.csv'
rows=list(csv.DictReader(open(src)))

def slug(s):
    s=s.lower().replace("'", "").replace("`","")
    s=re.sub(r'\(неполный[^)]*\)|\(возможно неполный\)','',s)
    s=re.sub(r'[^a-z0-9]+','_',s).strip('_')
    return s

TYPE_ROLE={'Угловой':'frame','Крыло':'sash','Средний':'mullion',
           'Балкон Угловой':'door_frame','Балкон Крыло':'door_sash','Балкон Средний':'door_mullion'}
MAT={'PVC':'pvc','Aluminium':'alu_cold','Thermo':'alu_thermo','Thermo aluminium':'alu_thermo',
     'Sill':'sill','PVC accessory':'pvc_accessory','Aluminium accessory':'alu_accessory',
     'Seal':'seal','Hardware':'hardware','Machine':'machine'}

def role_from_name(n, mat):
    s=n.lower()
    bal = 'balkon' in s or 'балкон' in s
    if re.search(r'stanok',s): return 'machine'
    if mat in ('pvc','alu_cold','alu_thermo'):
        m=re.search(r'\(\s*([lzt])\s*\)|\b([lzt])\s+oval|\bbalkon\s+([lzt])\b',s)
        if m and not re.search(r'archa|moskit|maskit',s):
            k=(m.group(1) or m.group(2) or m.group(3))
            base={'l':'frame','z':'sash','t':'mullion'}[k]
            return ('door_'+base) if bal else base
    if re.search(r'krishka',s) and re.search(r'podok|tokcha',s): return 'sill_cap'  # заглушка подоконника, штучно
    if re.search(r'podokonnik|tokcha|подоконник',s): return 'sill'
    if re.search(r'shtapik|штапик',s):
        if re.search(r'uchtalik|uch',s): return 'bead_triple'
        if re.search(r'odinar|24mm',s): return 'bead_single'
        return 'bead_igu'
    if re.search(r'metall|armatur|армир',s): return 'reinforcement'   # раньше штульпа: «Metall Shtulp» — армирование
    if mat=='pvc_accessory' and re.search(r'^universal|^balkon\s+[\d.,]+\s*mm|kosa\).*\d\s*mm',s): return 'reinforcement'  # Ekopen: «Universal Z(Qanot)…», «Balkon 1.5mm»
    if re.search(r'shtulp|штульп',s) and not re.search(r'ruchag|shpingalet|planka',s): return 'shtulp'
    if re.search(r'lambri|lmabri',s): return 'lambri'
    if re.search(r'metall|armatur|армир',s): return 'reinforcement'
    if re.search(r'rezina|epdm|tpv|uplotn|уплотн',s): return 'seal'
    if re.search(r'nojnits|ножниц',s): return 'fit_scissors'   # «Nojnitsa» и «Komplekt Nojnits … Fornax»
    if re.search(r'ispanil|испанол',s): return 'fit_drive'       # основной поворотно-откидной запор (привод)
    if re.search(r'^k[oa]mplekt\s*\(fornax\)',s): return 'fit_set'  # базовый комплект фурнитуры Fornax
    if re.search(r'krishka\s+petl',s): return 'fit_cap'                 # декоративная накладка петли
    if re.search(r'ruchka|ruchag|ручк',s): return 'fit_handle'   # раньше петель: «Ruchka … Dv Otk» — ручка
    if re.search(r'petlya|dv\.? ?otk|dv\. ?otk|петл',s): return 'fit_hinge'
    if re.search(r'zamok|zapor|tsalfa|otvetn|serdtsevina|shpingalet|замок',s): return 'fit_lock'
    if re.search(r'soed|chovush|соедин|chift quloq|klipsa',s): return 'connector'
    if re.search(r'gradus|razvarot',s): return 'joint_profile'
    if re.search(r'truba|turba|usilitel|ulanish|usilenniy profil|kvadrat profil',s): return 'coupling_profile'
    if re.search(r'porog|parog',s): return 'threshold'
    if re.search(r'moskit|maskit|sinaks',s): return 'mosquito_profile'
    if re.search(r'archa',s): return 'corner_cleat'
    if re.search(r'otvetka',s): return 'fit_lock'
    if re.search(r'lapsha',s): return 'thermo_insert'
    if re.search(r'rucha\b|ruchka',s): return 'fit_handle'
    if re.search(r'poliamid',s): return 'thermo_insert'
    if mat in ('pvc','alu_cold','alu_thermo'):
        if re.search(r'\bkosa\b',s): return 'door_frame' if bal else 'frame'
        if re.search(r'qanot',s): return 'door_sash' if bal else 'sash'
        if re.search(r"o.?rta|urta|\borta\b",s): return 'door_mullion' if bal else 'mullion'
    return 'other'

UNIT={'frame':'bar','sash':'bar','mullion':'bar','door_frame':'bar','door_sash':'bar','door_mullion':'bar',
      'bead_single':'bar','bead_igu':'bar','bead_triple':'bar','shtulp':'bar','lambri':'bar',
      'reinforcement':'bar','thermo_insert':'bar','sill':'bar','seal':'kg',  # sill: цена за хлыст, не за метр (опт Romchi в 3–4 раза выше розницы за метр)
      'joint_profile':'bar','coupling_profile':'bar','threshold':'bar','mosquito_profile':'bar'}

items=[]; sys_stats=collections.OrderedDict()
for i,r in enumerate(rows,1):
    mat=MAT[r['material']]
    series_clean=re.sub(r'\s*\((неполный[^)]*|возможно неполный)\)','',r['series']).strip()
    incomplete='1' if 'неполн' in r['series'] else '0'
    role=TYPE_ROLE.get(r['type']) or role_from_name(r['article'],mat)
    unit=UNIT.get(role,'pcs')
    pack_kg=''; pack_m=''; review_note=''
    if role=='seal':
        # цена в Romchi — за бухту: «(6kg)», «/250m 10kg», «80m»; без указаний, но ~820 тыс. — та же бухта 15 кг
        art=r['article']
        pk=re.search(r'(\d+(?:[.,]\d+)?)\s*kg',art,re.I)
        pm=re.search(r'/\s*(\d+)\s*m?\b|\b(\d+)\s*m\b',art,re.I)
        if re.search(r'krishka',art,re.I):
            unit='pcs'                                   # заглушки уплотнителя — штучно
        elif pk or pm:
            unit='pack'
            pack_kg=pk.group(1).replace(',','.') if pk else ''
            pack_m=(pm.group(1) or pm.group(2)) if pm else ''
        elif r['price_sum'] and float(r['price_sum'])>=500000:
            unit='pack'; review_note='вес бухты не указан, по цене похоже на 15 кг'
    syscode=slug(r['brand'])+'__'+slug(series_clean)
    m=None
    if role=='sill':
        mm=re.search(r'(\d{3})\s*mm',r['article'],re.I)   # «Tokcha 300mm»
        m=re.search(r'(\d{2})(?:\s*sm)?\b',r['article'],re.I)  # «Podokonnik 30», «Tokcha 30sm»
        if mm: m=re.match(r'(\d+)',str(int(mm.group(1))//10))
    items.append(dict(item_id=f'it{i:05d}',brand=r['brand'],material_class=mat,system_code=syscode,
        series=series_clean,price_updated=r['updated'],color=r['color'],pos=r['pos'],type_ru=r['type'],
        article=r['article'],role=role,unit=unit,unit_confirmed='0' if unit in('bar','m','kg','pack') else '1',pack_kg=pack_kg,pack_m=pack_m,
        sill_depth_cm=m.group(1) if m else '',price_sum=r['price_sum'],
        has_price='1' if r['price_sum'] else '0',series_incomplete=incomplete,
        needs_review='1' if role=='other' or review_note else '0',source='romchi_demo_2026-11'))
    st=sys_stats.setdefault(syscode,dict(system_code=syscode,brand=r['brand'],series=series_clean,material_class=mat,
        colors=set(),roles=set(),items=0,no_price=0,updated=r['updated'],incomplete=incomplete))
    st['colors'].add(r['color']); st['roles'].add(role); st['items']+=1; st['no_price']+= (r['price_sum']=='')

# ---- ДЕМО-цены для позиций без цены (price_sum пустой остаётся: правило P.1 в боевом режиме) ----
# Порядок: 1) та же позиция серии в другом цвете × медианный коэффициент цвета этой серии;
#          2) медиана той же позиции (артикула) в других сериях того же материала и цвета;
#          3) медиана роли в том же материале и цвете (и единице).
def _med(v):
    v=sorted(v); n=len(v)
    return (v[n//2] if n%2 else (v[n//2-1]+v[n//2])/2) if n else None
priced=[x for x in items if x['price_sum']]
by_sa=collections.defaultdict(dict)                    # (system, article) -> {color: price}
for x in priced: by_sa[(x['system_code'],x['article'])][x['color']]=float(x['price_sum'])
def color_ratio(sysc,c_to,c_from):
    rs=[d[c_to]/d[c_from] for (s_,a_),d in by_sa.items() if s_==sysc and c_to in d and c_from in d and d[c_from]>0]
    return _med(rs)
for x in items:
    x['demo_price_sum']=''; x['demo_price_basis']=''
    if x['price_sum']: continue
    other=by_sa.get((x['system_code'],x['article']),{})
    best=None
    for c_from,p in other.items():
        k=color_ratio(x['system_code'],x['color'],c_from)
        if k: best=(p*k,f"та же позиция, цвет «{c_from}» × {k:.2f} (коэф. цвета серии)"); break
    if not best and other:
        best=(_med(list(other.values())),"та же позиция в другом цвете, без коэффициента")
    if not best:
        v=[float(y['price_sum']) for y in priced if y['article']==x['article'] and y['material_class']==x['material_class'] and y['color']==x['color']]
        if v: best=(_med(v),f"медиана той же позиции в {len(v)} др. сериях")
    if not best:
        v=[float(y['price_sum']) for y in priced if y['role']==x['role'] and y['material_class']==x['material_class'] and y['color']==x['color'] and y['unit']==x['unit']]
        if v and x['role']!='other': best=(_med(v),f"медиана роли {x['role']} ({len(v)} поз.)")
    if best:
        x['demo_price_sum']=str(int(round(best[0],-2))); x['demo_price_basis']=best[1]

# ---- ДЕМО-позиции новых ролей (shapes_contract.md §7–8): фигурные, раскладка, открывания, сборки, цвет ----
# Не из Romchi: своя серия «Eskiz ДЕМО», цвет «—», цена только в demo_price_sum (боевой цех — P.1, пока не внесёт свою).
# variant (кремовый, матовое…) — в колонке type_ru. unit pct — наценка в % к цене белого профиля.
DEMO_SYS='eskiz__demo_roles'
import os
if os.path.exists('demo_roles.csv'):
    for r in csv.DictReader(open('demo_roles.csv',encoding='utf-8')):
        i=len(items)+1
        items.append(dict(item_id=f'it{i:05d}',brand='Eskiz ДЕМО',material_class='demo',system_code=DEMO_SYS,
            series='Новые роли (ДЕМО)',price_updated='',color='—',pos=str(i),type_ru=r['variant'],article=r['article'],
            role=r['role'],unit=r['unit'],unit_confirmed='0',pack_kg='',pack_m='',sill_depth_cm='',price_sum='',
            has_price='0',series_incomplete='0',needs_review='0',source='eskiz_demo_2026-11',
            demo_price_sum=r['demo_price_sum'],demo_price_basis=r['note']))
        st=sys_stats.setdefault(DEMO_SYS,dict(system_code=DEMO_SYS,brand='Eskiz ДЕМО',series='Новые роли (ДЕМО)',
            material_class='demo',colors=set(),roles=set(),items=0,no_price=0,updated='',incomplete='0'))
        st['colors'].add('—'); st['roles'].add(r['role']); st['items']+=1; st['no_price']+=1

with open('catalog_items.csv','w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(items[0].keys())); w.writeheader(); w.writerows(items)

def groove(st):
    # фурнитурный паз системы — ключ совместимости с наборами фурнитуры (fitting_systems.json)
    m=st['material_class']; c=st['system_code']
    if m=='pvc': return 'euro_pvc'
    if m in ('alu_cold','alu_thermo'):
        if re.search(r'_pvc\b|_pvc_',c+'_'): return 'euro_pvc'      # «PZ-50 (PVC)», «Termal 55 (PVC)» — алюминий под ПВХ-фурнитуру
        if m=='alu_thermo' or re.search(r'bkc50|adc|evro|euro',c): return 'euro_alu'
        return 'alu_plain'                                          # Aldoks и аналоги — поворотные окна на простых петлях
    return ''

def pclass(st):
    m=st['material_class']; s=st['series'].lower()
    if m=='pvc':
        num=re.search(r'(\d{4})',s)
        n=int(num.group(1)) if num else 6000
        return 'pvc_70' if n>=6500 else 'pvc_60'
    if m=='alu_cold': return 'alu_cold'
    if m=='alu_thermo': return 'alu_thermo'
    return ''
with open('systems.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow(['system_code','brand','series','material_class','passport_class','colors','has_frame','has_sash','has_mullion','has_door_profiles','items','items_without_price','price_updated','series_incomplete','usable_for_calc','fitting_groove'])
    for st in sys_stats.values():
        r_=st['roles']; pc=pclass(st)
        usable = pc!='' and {'frame','sash','mullion'}<=r_
        w.writerow([st['system_code'],st['brand'],st['series'],st['material_class'],pc,'|'.join(sorted(c for c in st['colors'] if c!='—')),
            int('frame' in r_),int('sash' in r_),int('mullion' in r_),int(bool(r_&{'door_frame','door_sash','door_mullion'})),
            st['items'],st['no_price'],st['updated'],st['incomplete'],int(usable),groove(st) if pc else ''])

c=collections.Counter(x['role'] for x in items)
print(len(items), c.most_common())
print('systems',len(sys_stats),'usable',sum(1 for s in sys_stats.values() if pclass(s) and {'frame','sash','mullion'}<=s['roles']))
