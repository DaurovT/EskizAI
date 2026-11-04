// Обёртка над web/next.config.mjs только для Docker-сборки (deploy/docker/web.Dockerfile).
// В образе исходный конфиг переименовывается в next.config.base.mjs, а этот файл
// кладётся на его место. Исходники web/ не меняются.
//
// Что добавляем:
// - output: 'standalone' — минимальный сервер (.next/standalone) без полного node_modules;
// - outputFileTracingRoot = корень репозитория — web подключает viewer как file:../viewer,
//   трассировка файлов должна видеть соседнюю папку.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from './next.config.base.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

const extend = (cfg) => ({
  ...cfg,
  output: 'standalone',
  // Next 15: опция вынесена из experimental на верхний уровень.
  outputFileTracingRoot: repoRoot,
});

export default typeof base === 'function'
  ? async (...args) => extend(await base(...args))
  : extend(base);
