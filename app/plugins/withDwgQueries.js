// Android 11+: чтобы Linking.canOpenURL("eskizdwg://…") видел установленный Eskiz DWG,
// в манифесте нужен <queries> с этой схемой (на iOS — LSApplicationQueriesSchemes в app.json).
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withDwgQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries || [{}];
    const q = manifest.queries[0];
    q.intent = q.intent || [];
    const has = q.intent.some((i) => (i.data || []).some((d) => d.$ && d.$['android:scheme'] === 'eskizdwg'));
    if (!has) {
      q.intent.push({
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        data: [{ $: { 'android:scheme': 'eskizdwg' } }],
      });
    }
    return cfg;
  });
};
