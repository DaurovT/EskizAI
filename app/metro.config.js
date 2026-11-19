// Metro: одна копия three.js в бандле.
// У three в package.json "exports": import → build/three.module.js, require → build/three.cjs.
// @react-three/fiber/native (CJS) делает require('three'), а наш код и three/examples/jsm (GLTFLoader) — import,
// и в бандл попадали обе сборки («Multiple instances of Three.js being imported», разные классы → instanceof ломается).
// Все «голые» импорты 'three' ведём в ESM-сборку.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// require.resolve('three') → build/three.cjs (package.json у three не экспортирован)
const THREE_ESM = path.join(path.dirname(require.resolve('three')), 'three.module.js');

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'three') return { type: 'sourceFile', filePath: THREE_ESM };
  return (defaultResolve || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
