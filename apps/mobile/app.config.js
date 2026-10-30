const base = require('./app.json').expo;
const release = require('./ios-release.json');
const { getBuildSettings } = require('./config/build-settings.cjs');
const { isRelease, origin, bundle, team, attest, buildNumber } = getBuildSettings();
module.exports = {
  ...base,
  scheme: isRelease ? 'justtaken' : base.scheme,
  version: isRelease ? release.version : base.version,
  ios: {
    ...base.ios,
    bundleIdentifier: bundle,
    usesAppleSignIn: true,
    appleTeamId: team,
    buildNumber,
    entitlements: { 'com.apple.developer.devicecheck.appattest-environment': attest },
    infoPlist: { ...base.ios.infoPlist, JustTakenAPIOrigin: origin },
  },
  android: { ...base.android, package: process.env.JUSTTAKEN_ANDROID_PACKAGE || bundle },
  plugins: [
    ...base.plugins,
    'expo-apple-authentication',
    [
      './plugins/withCaptureConfig',
      { apiOrigin: origin, projectNumber: process.env.GOOGLE_CLOUD_PROJECT_NUMBER || '' },
    ],
  ],
};
