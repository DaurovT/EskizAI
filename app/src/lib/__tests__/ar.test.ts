import type { ShareLinkOut } from '../../api/types';
import { ru } from '../../i18n/ru';
import { uz } from '../../i18n/uz';
import {
  arDims, arFileFor, arHintKey, arTitle, etaSeconds, formatMb, isArFresh, linkView, pickActiveLink, progressRatio,
  sceneViewerIntentUrl, sceneViewerUrl, whdToWdh,
} from '../ar';

const GLB = 'https://api.eskiz.uz/ar-files/abc+def.glb?sig=1&x=2';

describe('AR мастера: Scene Viewer', () => {
  it('https-ссылка: файл и название закодированы, только AR, масштаб зафиксирован', () => {
    const u = sceneViewerUrl(GLB, 'Шкаф · v4');
    expect(u.startsWith('https://arvr.google.com/scene-viewer/1.2?')).toBe(true);
    const q = new URL(u).searchParams;
    expect(q.get('file')).toBe(GLB);
    expect(q.get('mode')).toBe('ar_only');
    expect(q.get('resizable')).toBe('false');
    expect(q.get('title')).toBe('Шкаф · v4');
    // ссылка файла не «растекается» по параметрам Scene Viewer
    expect(u).not.toContain('&x=2');
  });

  it('запасной intent:// — на ARCore, с теми же параметрами и fallback', () => {
    const u = sceneViewerIntentUrl(GLB, 'Шкаф', 'https://eskiz.uz/s/demo');
    expect(u.startsWith('intent://arvr.google.com/scene-viewer/1.2?file=')).toBe(true);
    expect(u).toContain(`file=${encodeURIComponent(GLB)}`);
    expect(u).toContain('mode=ar_only&resizable=false');
    expect(u).toContain('#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;');
    expect(u).toContain(`S.browser_fallback_url=${encodeURIComponent('https://eskiz.uz/s/demo')};`);
    expect(u.endsWith(';end;')).toBe(true);
    expect(sceneViewerIntentUrl(GLB, 'x')).not.toContain('browser_fallback_url');
  });
});

describe('AR мастера: подсказка и файлы', () => {
  it('подсказка по размещению: пол по умолчанию, стена для навесного', () => {
    expect(arHintKey('floor')).toBe('ar_hint_floor');
    expect(arHintKey(null)).toBe('ar_hint_floor');
    expect(arHintKey(undefined)).toBe('ar_hint_floor');
    expect(arHintKey('wall')).toBe('ar_hint_wall');
    for (const d of [ru, uz]) {
      expect(d.ar_hint_floor).toBeTruthy();
      expect(d.ar_hint_wall).toBeTruthy();
      expect(d.ar_hint_wall).not.toBe(d.ar_hint_floor);
    }
    expect(ru.ar_hint_floor).toBe('Наведите камеру на пол у стены и нажмите. Двери открываются в 3D-редакторе, в AR модель в закрытом виде.');
  });

  it('iPhone — USDZ, Android — GLB; имя в кэше по версии', () => {
    const ar = { glb_url: 'https://a/x.glb', usdz_url: 'https://a/x.usdz', version_id: 'v/4:1' };
    expect(arFileFor(ar, 'ios')).toEqual({ url: 'https://a/x.usdz', name: 'ar-v_4_1.usdz', mime: 'model/vnd.usdz+zip' });
    expect(arFileFor(ar, 'android')).toEqual({ url: 'https://a/x.glb', name: 'ar-v_4_1.glb', mime: 'model/gltf-binary' });
  });

  it('ссылки свежие, пока до конца больше запаса', () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    expect(isArFresh({ expires_at: '2026-11-11T11:00:00Z' }, now)).toBe(true);
    expect(isArFresh({ expires_at: '2026-11-11T10:01:00Z' }, now)).toBe(false);
    expect(isArFresh({ expires_at: 'мусор' }, now)).toBe(false);
    expect(isArFresh(null, now)).toBe(false);
  });

  it('габарит: порядок контракта и перестановка из ModelSummary [Ш, В, Г]', () => {
    expect(arDims([1600, 600, 2400])).toBe('1600 × 600 × 2400');
    expect(arDims([1600.4, 0, 2400])).toBeNull();
    expect(arDims(null)).toBeNull();
    expect(whdToWdh([1600, 2400, 600])).toEqual([1600, 600, 2400]);
    expect(whdToWdh([1, 2])).toBeNull();
  });

  it('прогресс: мегабайты с запятой, доля и оставшееся время', () => {
    expect(formatMb(5_347_738)).toBe('5,1');
    expect(formatMb(8 * 1_048_576)).toBe('8');
    expect(formatMb(10)).toBe('0,1');
    expect(progressRatio(4, 8)).toBe(0.5);
    expect(progressRatio(4, -1)).toBeNull();
    expect(progressRatio(9, 8)).toBe(1);
    expect(etaSeconds(5_000_000, 8_000_000, 5000)).toBe(3);
    expect(etaSeconds(100, 8_000_000, 100)).toBeNull(); // слишком рано
    expect(etaSeconds(100, -1, 5000)).toBeNull(); // размер неизвестен
    expect(etaSeconds(8, 8, 5000)).toBeNull();
  });

  it('название для системного AR', () => {
    expect(arTitle('Шкаф', 4, '1600 × 600 × 2400', 'ru')).toBe('Шкаф · v4 · 1600 × 600 × 2400 мм');
    expect(arTitle('Shkaf', null, null, 'uz')).toBe('Shkaf');
  });
});

describe('AR мастера: ссылка клиенту', () => {
  const link = (over: Partial<ShareLinkOut>): ShareLinkOut => ({
    id: 'l', token: 't', url: 'https://eskiz.uz/s/t', version_id: 'v', language: 'ru', estimate_view: 'short', show_price: true,
    expires_at: '2026-12-01T00:00:00Z', revoked_at: null, views: 0, ar_starts: 0, ar_failures: 0, first_opened_at: null,
    agreed_at: null, created_at: '2026-11-01T00:00:00Z', ...over,
  });
  const now = Date.parse('2026-11-11T00:00:00Z');

  it('берёт самую свежую действующую, пропуская отозванные и истёкшие', () => {
    const links = [
      link({ id: 'old', created_at: '2026-10-01T00:00:00Z' }),
      link({ id: 'revoked', created_at: '2026-11-10T00:00:00Z', revoked_at: '2026-11-10T01:00:00Z' }),
      link({ id: 'expired', created_at: '2026-11-09T00:00:00Z', expires_at: '2026-11-10T00:00:00Z' }),
      link({ id: 'new', created_at: '2026-11-05T00:00:00Z' }),
    ];
    expect(pickActiveLink(links, now)?.id).toBe('new');
    expect(pickActiveLink([links[1], links[2]], now)).toBeNull();
    expect(pickActiveLink(null, now)).toBeNull();
  });

  it('вид сметы новой ссылки — как на экране отправки', () => {
    expect(linkView('short', ['total', 'short', 'detailed'])).toBe('short');
    expect(linkView('detailed', ['total'])).toBe('total');
    expect(linkView(undefined, ['short', 'total'])).toBe('short');
    expect(linkView('short', [])).toBe('total');
  });
});

describe('scene viewer wall placement', () => {
  it('adds vertical placement only for wall-mounted items', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sceneViewerUrl, sceneViewerIntentUrl } = require('../ar');
    expect(sceneViewerUrl('https://x/a.glb', 'T', true)).toContain('enable_vertical_placement=true');
    expect(sceneViewerUrl('https://x/a.glb', 'T')).not.toContain('enable_vertical_placement');
    expect(sceneViewerIntentUrl('https://x/a.glb', 'T', undefined, true)).toContain('enable_vertical_placement=true');
  });
});
