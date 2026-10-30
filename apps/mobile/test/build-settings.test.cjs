const test = require('node:test');
const assert = require('node:assert/strict');
const { getBuildSettings, productionEnvironment } = require('../config/build-settings.cjs');

test('development keeps the local endpoint and separate app identity', () => {
  const config = getBuildSettings({});
  assert.equal(config.bundle, 'app.justtaken.dev');
  assert.equal(config.isRelease, false);
  assert.equal(config.attest, 'development');
});
test('production command replaces inherited local settings for native and JS bundles', () => {
  const env = productionEnvironment({
    EXPO_PUBLIC_API_URL: 'http://localhost:8787',
    JUSTTAKEN_BUNDLE_ID: 'app.justtaken.dev',
    IOS_BUILD_NUMBER: '12',
  });
  const config = getBuildSettings(env);
  assert.equal(config.origin, 'https://justtaken.app');
  assert.equal(config.bundle, 'app.justtaken.ios');
  assert.equal(config.attest, 'production');
  assert.equal(config.buildNumber, '12');
});
for (const [name, value] of Object.entries({
  EXPO_PUBLIC_API_URL: 'http://localhost:8787',
  JUSTTAKEN_BUNDLE_ID: 'app.justtaken.dev',
  APPLE_TEAM_ID: 'OTHERTEAM1',
  APP_ATTEST_ENVIRONMENT: 'development',
})) {
  test(`release fails closed when ${name} is wrong`, () => {
    assert.throws(
      () => getBuildSettings({ ...productionEnvironment({}), [name]: value }),
      new RegExp(name),
    );
  });
}
test('missing configuration cannot silently produce a production build', () => {
  assert.throws(() => getBuildSettings({ JUSTTAKEN_RELEASE: '1' }), /Release build requires/);
  assert.throws(
    () => getBuildSettings({ EAS_BUILD_PROFILE: 'production' }),
    /Release build requires/,
  );
});
test('build numbers and attestation environments are validated', () => {
  for (const value of ['0', '-1', '1.0', 'abc', '1000000000'])
    assert.throws(() => getBuildSettings({ IOS_BUILD_NUMBER: value }), /IOS_BUILD_NUMBER/);
  assert.throws(
    () => getBuildSettings({ APP_ATTEST_ENVIRONMENT: 'test' }),
    /APP_ATTEST_ENVIRONMENT/,
  );
});
