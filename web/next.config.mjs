import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nm = (p) => path.join(here, 'node_modules', p);

/**
 * @mebel/viewer подключён как file:../viewer (симлинк). У viewer свои
 * node_modules для тестов и сборки, поэтому общие библиотеки жёстко берём
 * из web/node_modules — иначе в бандле будет два three и два R3F.
 * react / react-dom не трогаем: Next сам подставляет свою сборку React
 * для любых модулей, включая viewer.
 * Когда появится общий workspace в корне репозитория, алиасы можно убрать.
 */
const shared = {
  three: nm('three'),
  '@react-three/fiber': nm('@react-three/fiber'),
  '@react-three/drei': nm('@react-three/drei'),
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Отдельная папка сборки для второго dev-сервера (NEXT_DIST_DIR), по умолчанию .next
  distDir: process.env.NEXT_DIST_DIR || '.next',
  webpack(config) {
    config.resolve.alias = { ...(config.resolve.alias ?? {}), ...shared };
    return config;
  },
};

export default nextConfig;
