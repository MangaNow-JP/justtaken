import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await mkdir('artifacts/verifier', { recursive: true });
await build({
  entryPoints: ['scripts/verify-proof.ts'],
  outfile: 'artifacts/verifier/justtaken-verify.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'eof',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await copyFile(
  'workers/api/trust/justtaken-production-jwks.json',
  'artifacts/verifier/justtaken-production-jwks.json',
);
await writeFile(
  'artifacts/verifier/README.txt',
  `JustTaken independent verifier — Node.js 22 or later\n\n` +
    `Keep this directory and the trusted public key outside JustTaken operator storage.\n` +
    `The checksums detect later file changes only if you preserve the original checksum file.\n` +
    `Do not replace trusted keys solely because an untrusted proof asks you to do so.\n\n` +
    `Verify a production proof and its original file:\n` +
    `node justtaken-verify.mjs proof.json original.heic justtaken-production-jwks.json https://justtaken.app --online --state=recipient-history.json\n\n` +
    `Omit --online for offline verification of embedded evidence.\n` +
    `Keep recipient-history.json to detect changed certificates for previously seen proof IDs and compare log checkpoints.\n` +
    `HEIF, JPEG, DNG and videos are hashed as bytes without transcoding.\n` +
    `A valid proof does not establish the truth of the scene or the person's legal identity.\n`,
);
const files = ['justtaken-verify.mjs', 'justtaken-production-jwks.json', 'README.txt'];
const checksums = await Promise.all(
  files.map(async (file) => {
    const bytes = await readFile('artifacts/verifier/' + file);
    return createHash('sha256').update(bytes).digest('hex') + '  ' + file + '\n';
  }),
);
await writeFile('artifacts/verifier/SHA256SUMS', checksums.join(''));
console.log(
  'Built portable independent verifier (Node 22); retain this file and trusted issuer keys outside operator storage.',
);
