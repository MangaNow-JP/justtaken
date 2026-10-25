// LOCAL UI TEST ONLY. Never imported/deployed by the app or Worker.
// Synthetic HEIF + ephemeral key; this is NOT evidence of a real camera capture.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, CompactSign } from 'jose';
import { verifierRoutes } from '../workers/api/src/verifier';
async function main() {
  const issuer = 'http://localhost:8799',
    dir = 'artifacts/proof-ui';
  await mkdir(dir, { recursive: true });
  const bytes = await readFile('workers/api/test/fixtures/heif-hdr.heic');
  const original = {
    ...JSON.parse(await readFile('workers/api/test/fixtures/heif-hdr.json', 'utf8')),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'ui-test-only', alg: 'ES256', use: 'sig' }],
  };
  const now = new Date().toISOString();
  const payload = {
    version: 1,
    issuer,
    proofId: randomUUID(),
    creatorId: randomUUID(),
    issuedAt: now,
    deviceCapturedAt: now,
    serverCommittedAt: now,
    serverVerifiedAt: now,
    policyVersion: 'capture-v3',
    kind: 'photo',
    original,
    manifestDigest: '0'.repeat(64),
    evidence: { method: 'apple-app-attest', deviceEnvironment: 'test', serviceEnvironment: 'test' },
    scope: 'app-capture-and-file-integrity',
    subjectTruthGuaranteed: false,
    personIdentityVerified: false,
  };
  const certificate = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: 'ES256', kid: 'ui-test-only', typ: 'justtaken-proof+jws' })
    .sign(keys.privateKey);
  const bundle = { format: 'justtaken-proof-v1', certificate };
  await writeFile(dir + '/test-proof.json', JSON.stringify(bundle, null, 2));
  await writeFile(dir + '/trusted-test-jwks.json', JSON.stringify(jwks, null, 2));
  await writeFile(dir + '/original.heic', bytes);
  const altered = Buffer.from(bytes);
  altered[altered.length - 1] ^= 1;
  await writeFile(dir + '/changed.heic', altered);
  const segments = certificate.split('.');
  segments[1] = Buffer.from(JSON.stringify({ ...payload, creatorId: randomUUID() })).toString(
    'base64url',
  );
  await writeFile(
    dir + '/changed-proof.json',
    JSON.stringify({ ...bundle, certificate: segments.join('.') }),
  );
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, issuer).pathname;
    console.log(req.method + ' ' + path); // paths only; allows verifying no media upload occurs
    const response =
      path === '/.well-known/capture-jwks.json'
        ? Response.json(jwks)
        : verifierRoutes(new Request(issuer + path, { method: req.method }));
    if (!response) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(8799, '127.0.0.1', () =>
    console.log('TEST ONLY verifier at ' + issuer + '/verify'),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
