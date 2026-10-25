// Explicit opt-in network test: publishes ONLY a random synthetic commitment and ephemeral public key.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK } from 'jose';
import {
  createLogRequest,
  newNonce,
  obtainLog,
  obtainTimestamp,
  checkLiveLog,
} from '../workers/api/src/anchor-client';
import { verifyAnchors, verifyTimestamp } from '../workers/api/src/anchor-crypto';
async function main() {
  if (!process.argv.includes('--publish-synthetic-commitment'))
    throw new Error('Explicit opt-in required');
  const dir = 'artifacts/anchors';
  await mkdir(dir, { recursive: true });
  const certificate = process.argv.includes('--ui-fixture')
    ? JSON.parse(await readFile('artifacts/proof-ui/test-proof.json', 'utf8')).certificate
    : 'JustTaken synthetic external anchor test ' + crypto.randomUUID();
  const key = await generateKeyPair('ES256', { extractable: true });
  const nonce = newNonce();
  const timestamp = await obtainTimestamp(certificate, nonce);
  console.log('RFC 3161 timestamp verified:', await verifyTimestamp(certificate, timestamp, nonce));
  const request = await createLogRequest(certificate, timestamp, await exportJWK(key.privateKey));
  const log = await obtainLog(certificate, timestamp, request);
  const bundle = {
    format: 'justtaken-proof-v1' as const,
    certificate,
    anchors: { version: 1 as const, provider: 'sigstore-v1' as const, nonce, timestamp, log },
  };
  await writeFile(dir + '/external-test-proof.json', JSON.stringify(bundle, null, 2));
  const result = await verifyAnchors(bundle);
  const current = await checkLiveLog(result.checkpoint);
  console.log('Public log inclusion and live consistency verified:', {
    size: current.size,
    origin: current.origin,
  });
  const retry = await obtainLog(certificate, timestamp, request);
  if (retry.body !== log.body || retry.logIndex !== log.logIndex)
    throw new Error('Idempotent retry mismatch');
  console.log('Duplicate submission recovered the same public log entry.');
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
