// Metro: подключаем общий пакет ../viewer (симлинк file:../viewer) и образцы ../schemas/samples.
// Важно: у viewer в node_modules свои копии three / react / R3F (devDependencies для его тестов).
// Все «голые» импорты из файлов viewer резолвим так, как будто они сделаны из app —
// иначе в бандле будет две копии three и React, и R3F сломается.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const appDir = __dirname;
const viewerDir = path.resolve(appDir, '../viewer');
const schemasDir = path.resolve(appDir, '../schemas');

const config = getDefaultConfig(appDir);

config.watchFolders = [viewerDir, schemasDir];
config.resolver.nodeModulesPaths = [path.resolve(appDir, 'node_modules')];
// viewer/node_modules не нужен бандлу вообще.
config.resolver.blockList = [new RegExp(`${viewerDir.replace(/[/\\]/g, '[/\\\\]')}[/\\\\]node_modules[/\\\\].*`)];

const ALIASES = {
  // Корень пакета: ядро сцены без React.
  '@mebel/viewer': path.join(viewerDir, 'dist/index.js'),
  // Только ProductObject: ProductViewer из index тянет @react-three/drei и DOM, в RN он не нужен.
  '@mebel/viewer/react': path.join(viewerDir, 'dist/react/ProductObject.js'),
};

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (ALIASES[moduleName]) {
    return { type: 'sourceFile', filePath: ALIASES[moduleName] };
  }
  const origin = context.originModulePath || '';
  const isBare = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
  if (isBare && origin.startsWith(viewerDir + path.sep)) {
    const ctx = { ...context, originModulePath: path.join(appDir, 'package.json') };
    return (defaultResolve || context.resolveRequest)(ctx, moduleName, platform);
  }
  return (defaultResolve || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
