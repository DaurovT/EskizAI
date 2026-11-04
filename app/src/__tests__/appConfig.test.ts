/** app.config.js + plugins/withDevHttp: http:// в локальной сети разрешён только в development / preview. */
/* eslint-disable @typescript-eslint/no-require-imports */
const appJson = require('../../app.json');

type ModResult = { modResults: Record<string, unknown> };
type Mod = (c: ModResult & { modRequest?: unknown }) => Promise<ModResult> | ModResult;

function configFor(variant: string | undefined) {
  jest.resetModules();
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  const make = require('../../app.config.js');
  return make({ config: appJson.expo });
}

async function atsFor(variant: string | undefined) {
  const cfg = configFor(variant);
  const entry = cfg.plugins.find((p: unknown) => Array.isArray(p) && p[0] === './plugins/withDevHttp');
  const withDevHttp = require('../../plugins/withDevHttp.js');
  const out = withDevHttp({ name: 'x', slug: 'x' }, entry[1]);
  const mod: Mod = out.mods.ios.infoPlist;
  const res = await mod({ modResults: {}, modRequest: { platform: 'ios', modName: 'infoPlist', introspect: true } });
  return { ats: res.modResults.NSAppTransportSecurity as Record<string, boolean>, variant: cfg.extra.appVariant };
}

describe('APP_VARIANT → ATS', () => {
  const saved = process.env.APP_VARIANT;
  afterAll(() => { if (saved === undefined) delete process.env.APP_VARIANT; else process.env.APP_VARIANT = saved; });

  it('по умолчанию production: произвольный http закрыт', async () => {
    const r = await atsFor(undefined);
    expect(r.variant).toBe('production');
    expect(r.ats.NSAllowsArbitraryLoads).toBe(false);
  });
  it('production: закрыт', async () => {
    expect((await atsFor('production')).ats.NSAllowsArbitraryLoads).toBe(false);
  });
  it('development и preview: открыт для API в локальной сети', async () => {
    expect((await atsFor('development')).ats.NSAllowsArbitraryLoads).toBe(true);
    expect((await atsFor('preview')).ats.NSAllowsArbitraryLoads).toBe(true);
  });
  it('опечатка в APP_VARIANT — ошибка, а не тихий production/dev', () => {
    expect(() => configFor('prod')).toThrow(/APP_VARIANT/);
  });
});
