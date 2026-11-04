/**
 * Динамическая часть конфигурации поверх app.json (Expo передаёт его сюда как `config`).
 *
 * APP_VARIANT — development | preview | production (по умолчанию production — безопасно).
 *   development и preview разрешают http:// до API в локальной сети (plugins/withDevHttp.js),
 *   production — нет. В EAS переменная задана в профилях eas.json.
 */
const VARIANTS = ['development', 'preview', 'production'];
const variant = process.env.APP_VARIANT || 'production';
if (!VARIANTS.includes(variant)) {
  throw new Error(`APP_VARIANT="${variant}": ожидается одно из ${VARIANTS.join(', ')}`);
}

module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    ['./plugins/withDevHttp', { enabled: variant !== 'production' }],
  ],
  extra: { ...(config.extra ?? {}), appVariant: variant },
});
