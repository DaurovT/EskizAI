// Замер сцены по пресетам качества: вызовы отрисовки (draw calls) и треугольники.
// Запуск: npm run bench (сначала собирает dist/).
// Draw calls — главный показатель для бюджетных Android: каждый вызов стоит
// времени CPU и драйвера, а треугольников у мебели мало.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ProductScene, parseViewerModel, qualitySettings } from '../dist/index.js';

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['kitchen_straight', 'wardrobe_full'];
const presets = ['high', 'medium', 'low'];

const load = (name) =>
  parseViewerModel(JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}.viewer.json`, import.meta.url)), 'utf8')));

// ContactShadows (drei): 'dynamic' — каждый кадр ещё раз рисует сцену с материалом
// глубины + 2 прохода размытия; 'static' — только в первом кадре; 'none' — ничего.
const shadowCalls = (mode, calls) => (mode === 'dynamic' ? calls + 2 : 0);

const rows = [];
for (const name of models) {
  const model = load(name);
  for (const q of presets) {
    const t0 = performance.now();
    const s = new ProductScene(model, { quality: q });
    const buildMs = performance.now() - t0;
    const closed = s.stats();
    s.setExplode(1);
    const exploded = s.stats();
    s.setExplode(0);
    s.highlight(model.parts[0].number);
    const highlighted = s.stats();
    s.clearHighlight();
    s.showDimensions(true);
    const withDims = s.stats();
    const qs = qualitySettings(q);
    rows.push({
      model: name,
      quality: q,
      parts: model.parts.length,
      nodes: model.nodes.length,
      drawCalls: closed.drawCalls,
      triangles: closed.triangles,
      perFrameOrbit: closed.drawCalls + shadowCalls(qs.shadows, closed.drawCalls),
      exploded: exploded.drawCalls,
      highlight: highlighted.drawCalls,
      dims: withDims.drawCalls,
      maxDpr: qs.maxPixelRatio,
      buildMs: Math.round(buildMs),
    });
    s.dispose();
  }
}
console.table(rows);
console.log(
  'drawCalls — сцена в закрытом виде; perFrameOrbit — оценка за кадр при вращении с тенью; ' +
    'exploded — при «взрыве» (слитые меши разбираются); highlight — с подсветкой одной детали; dims — с размерами.',
);
