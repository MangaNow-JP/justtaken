const { withAndroidManifest } = require('expo/config-plugins');
module.exports = (config, options) => withAndroidManifest(config, (mod) => {
  const app = mod.modResults.manifest.application[0];
  app['meta-data'] = (app['meta-data'] || []).filter((x) => !['app.justtaken.API_ORIGIN','app.justtaken.INTEGRITY_PROJECT'].includes(x.$['android:name']));
  app['meta-data'].push({$: {'android:name':'app.justtaken.API_ORIGIN','android:value':options.apiOrigin}},{$:{'android:name':'app.justtaken.INTEGRITY_PROJECT','android:value':'project:'+options.projectNumber}});
  return mod;
});
