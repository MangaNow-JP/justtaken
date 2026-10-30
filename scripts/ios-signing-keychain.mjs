import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Provision the dedicated keychain separately with the owner's approval.
// This helper only opens that keychain for one release operation.
export function openSigningKeychain(directory) {
  const root = resolve(directory);
  const keychain = join(root, 'justtaken.keychain-db');
  const passwordFile = join(root, 'keychain.password');
  for (const path of [root, keychain, passwordFile]) {
    const info = statSync(path);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
      throw new Error(
        'The dedicated signing directory and credentials must be accessible only to the current user.',
      );
    }
  }
  const password = readFileSync(passwordFile, 'utf8');
  if (!password) throw new Error('The dedicated signing keychain password file is empty.');
  const security = (args) => {
    const result = spawnSync('/usr/bin/security', args, {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (result.status !== 0) {
      // Do not include arguments or child-process errors: they can contain the password.
      throw new Error(`Signing keychain operation failed: ${args[0]} (exit ${result.status}).`);
    }
    return result.stdout;
  };
  const previous = [...security(['list-keychains', '-d', 'user']).matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  if (!previous.length) throw new Error('Cannot preserve the existing keychain search list.');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      security(['list-keychains', '-d', 'user', '-s', ...previous]);
    } finally {
      security(['lock-keychain', keychain]);
    }
  };
  try {
    security(['unlock-keychain', '-p', password, keychain]);
    security([
      'list-keychains',
      '-d',
      'user',
      '-s',
      keychain,
      ...previous.filter((path) => path !== keychain),
    ]);
    return close;
  } catch (error) {
    close();
    throw error;
  }
}
