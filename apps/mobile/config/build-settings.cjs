const release = require('../ios-release.json');

function getBuildSettings(env = process.env) {
  const isRelease = env.JUSTTAKEN_RELEASE === '1' || env.EAS_BUILD_PROFILE === 'production';
  const origin = (env.EXPO_PUBLIC_API_URL || 'http://localhost:8787').replace(/\/$/, '');
  const bundle = env.JUSTTAKEN_BUNDLE_ID || 'app.justtaken.dev';
  const team = env.APPLE_TEAM_ID || undefined;
  const attest = env.APP_ATTEST_ENVIRONMENT || 'development';
  const buildNumber = env.IOS_BUILD_NUMBER || '1';
  if (!/^[1-9]\d{0,8}$/.test(buildNumber))
    throw new Error('IOS_BUILD_NUMBER must be a positive integer (up to 9 digits).');
  if (!['development', 'production'].includes(attest))
    throw new Error('Invalid APP_ATTEST_ENVIRONMENT.');
  if (isRelease) {
    const expected = {
      EXPO_PUBLIC_API_URL: [origin, release.apiOrigin],
      JUSTTAKEN_BUNDLE_ID: [bundle, release.bundleIdentifier],
      APPLE_TEAM_ID: [team, release.teamId],
      APP_ATTEST_ENVIRONMENT: [attest, 'production'],
    };
    for (const [name, [actual, required]] of Object.entries(expected)) {
      if (actual !== required) throw new Error(`Release build requires ${name}=${required}.`);
    }
  }
  return { isRelease, origin, bundle, team, attest, buildNumber };
}

function productionEnvironment(env = process.env) {
  return {
    ...env,
    JUSTTAKEN_RELEASE: '1',
    EXPO_PUBLIC_API_URL: release.apiOrigin,
    EXPO_PUBLIC_AUTH_SCHEME: 'justtaken',
    JUSTTAKEN_BUNDLE_ID: release.bundleIdentifier,
    APPLE_TEAM_ID: release.teamId,
    APP_ATTEST_ENVIRONMENT: 'production',
    IOS_BUILD_NUMBER: env.IOS_BUILD_NUMBER || '1',
  };
}
module.exports = { getBuildSettings, productionEnvironment };
