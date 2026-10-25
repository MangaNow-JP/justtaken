const base = require('./app.json').expo;
const origin = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:8787';
const bundle = process.env.JUSTTAKEN_BUNDLE_ID || 'app.justtaken.dev';
module.exports = {
  ...base,
  ios: {...base.ios, bundleIdentifier:bundle, usesAppleSignIn:true,
    appleTeamId:process.env.APPLE_TEAM_ID,
    entitlements:{'com.apple.developer.devicecheck.appattest-environment':process.env.APP_ATTEST_ENVIRONMENT || 'development'},
    infoPlist:{...base.ios.infoPlist,JustTakenAPIOrigin:origin}},
  android:{...base.android,package:process.env.JUSTTAKEN_ANDROID_PACKAGE || bundle},
  plugins:[...base.plugins,'expo-apple-authentication',['./plugins/withCaptureConfig',{apiOrigin:origin,projectNumber:process.env.GOOGLE_CLOUD_PROJECT_NUMBER || ''}]],
};
