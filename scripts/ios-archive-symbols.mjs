import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Vendor xcframework dSYMs are not always copied by CocoaPods' embed phase.
// Copy only real symbol bundles whose UUID matches the archived binary.
export function collectArchiveSymbols(root, archive) {
  const uuids = (path) => {
    const result = spawnSync('xcrun', ['dwarfdump', '--uuid', path], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    return [...result.stdout.matchAll(/UUID: ([0-9A-F-]+)/g)].map((match) => match[1]);
  };
  const listing = spawnSync(
    'rg',
    ['--files', '-uu', 'apps/mobile/ios/Pods', 'node_modules/expo-image/prebuilds'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (listing.status !== 0) throw new Error('Cannot locate vendor symbol bundles.');
  const symbols = new Map();
  for (const relative of listing.stdout
    .split('\n')
    .filter((path) => path.includes('.dSYM/Contents/Resources/DWARF/'))) {
    const path = join(root, relative);
    for (const uuid of uuids(path)) symbols.set(uuid, path.slice(0, path.indexOf('.dSYM/') + 5));
  }
  const destination = join(archive, 'dSYMs');
  mkdirSync(destination, { recursive: true });
  const frameworks = join(archive, 'Products/Applications/JustTaken.app/Frameworks');
  const copied = [],
    missing = [];
  for (const framework of readdirSync(frameworks).filter((name) => name.endsWith('.framework'))) {
    const binary = join(frameworks, framework, framework.slice(0, -10));
    const ids = uuids(binary);
    if (!ids.length) throw new Error('Cannot inspect archived framework: ' + framework);
    const installed = readdirSync(destination)
      .filter((name) => name.endsWith('.dSYM'))
      .some((name) => {
        const dwarf = join(destination, name, 'Contents/Resources/DWARF', framework.slice(0, -10));
        return existsSync(dwarf) && ids.every((id) => uuids(dwarf).includes(id));
      });
    if (installed) continue;
    const source = symbols.get(ids[0]);
    if (!source) {
      missing.push({ framework, uuids: ids });
      continue;
    }
    const dwarf = join(source, 'Contents/Resources/DWARF', framework.slice(0, -10));
    if (!ids.every((id) => uuids(dwarf).includes(id)))
      throw new Error('Symbol architecture mismatch: ' + framework);
    cpSync(source, join(destination, basename(source)), { recursive: true });
    copied.push(framework);
  }
  writeFileSync(
    join(dirname(archive), basename(archive) + '.symbols.json'),
    JSON.stringify({ copied, missing }, null, 2),
  );
  console.log(`Vendor debug symbols: ${copied.length} copied; ${missing.length} unavailable.`);
}
