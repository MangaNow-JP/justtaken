import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { productionEnvironment, getBuildSettings } from '../apps/mobile/config/build-settings.cjs';
import { openSigningKeychain } from './ios-signing-keychain.mjs';
import { collectArchiveSymbols } from './ios-archive-symbols.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
const env = productionEnvironment();
const config = getBuildSettings(env);
const action = process.argv[2] || 'config';
const require = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const release = require('./ios-release.json');
const archivePath = `${root}artifacts/JustTaken-${config.buildNumber}.xcarchive`;
const exportOptionsPath = `${root}artifacts/ios-${action === 'upload' ? 'upload' : 'export'}-options.plist`;
const commands = {
  config: ['npx', ['expo', 'config', '--type', 'public']],
  prebuild: ['npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install']],
  compile: [
    'xcodebuild',
    [
      '-workspace',
      'ios/JustTaken.xcworkspace',
      '-scheme',
      'JustTaken',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-derivedDataPath',
      `${root}artifacts/ios-release-build`,
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'build',
    ],
  ],
  archive: [
    'xcodebuild',
    [
      '-workspace',
      'ios/JustTaken.xcworkspace',
      '-scheme',
      'JustTaken',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      archivePath,
      '-derivedDataPath',
      `${root}artifacts/ios-release-build`,
      'archive',
    ],
  ],
  export: [
    'xcodebuild',
    [
      '-exportArchive',
      '-archivePath',
      archivePath,
      '-exportOptionsPlist',
      exportOptionsPath,
      '-exportPath',
      `${root}artifacts/ios-export-${config.buildNumber}`,
    ],
  ],
  upload: [
    'xcodebuild',
    [
      '-exportArchive',
      '-archivePath',
      archivePath,
      '-exportOptionsPlist',
      exportOptionsPath,
      '-exportPath',
      `${root}artifacts/ios-upload-${config.buildNumber}`,
    ],
  ],
};
commands['device-export'] = [
  'xcodebuild',
  [
    '-exportArchive',
    '-archivePath',
    archivePath,
    '-exportOptionsPlist',
    exportOptionsPath,
    '-exportPath',
    `${root}artifacts/ios-device-${config.buildNumber}`,
  ],
];
if (!commands[action])
  throw new Error(
    'Usage: node scripts/ios-release.mjs config|prebuild|compile|archive|export|device-export|upload',
  );
mkdirSync(`${root}artifacts`, { recursive: true });
if (action === 'archive') {
  // RN's optional symbols live inside the downloaded framework. CocoaPods must
  // exclude them before signing the embedded framework (App Store rejects DWARF
  // executables inside an app). The archive's separate dSYMs folder retains them.
  const embedPath = `${cwd}ios/Pods/Target Support Files/Pods-JustTaken/Pods-JustTaken-frameworks.sh`;
  const embed = readFileSync(embedPath, 'utf8');
  if (!embed.includes('--filter "- Headers"'))
    throw new Error('Unexpected CocoaPods framework embed script.');
  if (!embed.includes('--filter "- dSYMs"'))
    writeFileSync(
      embedPath,
      embed.replaceAll('--filter "- Headers"', '--filter "- dSYMs" --filter "- Headers"'),
    );
  // Scope signing to the app's Release target; never apply its profile to CocoaPods targets.
  const { IOSConfig } = require('expo/config-plugins');
  const utils = IOSConfig.XcodeUtils;
  const project = utils.getPbxproj(cwd);
  const { target } = utils.getApplicationNativeTarget({ project, projectName: 'JustTaken' });
  const [, build] = utils.getBuildConfigurationForListIdAndName(project, {
    configurationListId: target.buildConfigurationList,
    buildConfiguration: 'Release',
  });
  if (
    String(build.buildSettings.PRODUCT_BUNDLE_IDENTIFIER).replaceAll('"', '') !==
    release.bundleIdentifier
  )
    throw new Error(
      'Native project is not configured for the registered app. Run ios:release:prebuild and pod install first.',
    );
  build.buildSettings.CODE_SIGN_STYLE = 'Manual';
  build.buildSettings.DEVELOPMENT_TEAM = release.teamId;
  build.buildSettings['"CODE_SIGN_IDENTITY[sdk=iphoneos*]"'] = release.signingCertificate;
  build.buildSettings.PROVISIONING_PROFILE_SPECIFIER = `"${release.provisioningProfile}"`;
  build.buildSettings.CURRENT_PROJECT_VERSION = config.buildNumber;
  delete build.buildSettings.PROVISIONING_PROFILE;
  writeFileSync(project.filepath, project.writeSync());
  const plist = require('@expo/plist').default;
  const infoPath = `${cwd}ios/JustTaken/Info.plist`;
  const info = plist.parse(readFileSync(infoPath, 'utf8'));
  info.CFBundleVersion = config.buildNumber;
  writeFileSync(infoPath, plist.build(info));
}
if (['export', 'upload', 'device-export'].includes(action)) {
  const plist = require('@expo/plist').default;
  const result = spawnSync(
    'plutil',
    [
      '-convert',
      'xml1',
      '-o',
      '-',
      `${archivePath}/Products/Applications/JustTaken.app/Info.plist`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error('Cannot read the archived app version.');
  const info = plist.parse(result.stdout);
  if (
    info.CFBundleVersion !== config.buildNumber ||
    info.CFBundleIdentifier !== release.bundleIdentifier
  )
    throw new Error('Archive version or bundle identifier does not match the requested release.');
  const escape = (value) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  writeFileSync(
    exportOptionsPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>${action === 'device-export' ? 'release-testing' : 'app-store-connect'}</string>
<key>destination</key><string>${action === 'upload' ? 'upload' : 'export'}</string>
<key>teamID</key><string>${escape(release.teamId)}</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>${escape(release.signingCertificate)}</string>
<key>provisioningProfiles</key><dict><key>${escape(release.bundleIdentifier)}</key><string>${escape(action === 'device-export' ? 'JustTaken iPhone Test 2026' : release.provisioningProfile)}</string></dict>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>generateAppStoreInformation</key><true/>
<key>uploadSymbols</key><true/>
</dict></plist>
`,
  );
}
const [command, args] = commands[action];
const closeSigningKeychain = ['archive', 'export', 'upload', 'device-export'].includes(action)
  ? openSigningKeychain(env.JUSTTAKEN_SIGNING_DIRECTORY || `${root}artifacts/ios-signing-isolated`)
  : () => {};
try {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && action === 'archive') collectArchiveSymbols(root, archivePath);
} finally {
  closeSigningKeychain();
}
