/**
 * Обычный HTTP (без TLS) до API в локальной сети — только для сборок development / preview.
 * iOS: NSAppTransportSecurity.NSAllowsArbitraryLoads (ATS не пускает http:// на IP в сети, например http://192.168.1.54:8000).
 * Android: usesCleartextTraffic (Release-сборки по умолчанию запрещают http://).
 * В production (APP_VARIANT=production или не задан) — всё закрыто, ATS по умолчанию.
 */
const { withInfoPlist, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withDevHttp(config, { enabled = false } = {}) {
  config = withInfoPlist(config, (c) => {
    c.modResults.NSAppTransportSecurity = enabled
      ? { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true }
      : { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true };
    return c;
  });
  config = withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application?.[0];
    if (app) {
      if (enabled) app.$['android:usesCleartextTraffic'] = 'true';
      else delete app.$['android:usesCleartextTraffic'];
    }
    return c;
  });
  return config;
};
