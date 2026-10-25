// Offline verifier. Trust anchors must be supplied independently by the recipient.
import { readFile, stat, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyProof, type ProofTrust } from '../workers/api/src/proof-verify';
import { proofBundleSchema } from '@justtaken/contracts/proof';
import {
  checkProofPin,
  hash,
  verifyAnchors,
  verifyCheckpoint,
  verifyConsistency,
} from '../workers/api/src/anchor-crypto';
import { checkLiveLog } from '../workers/api/src/anchor-client';
async function main() {
  const [certificatePath, originalPath, trustedJWKSPath, trustedIssuer, ...flags] =
    process.argv.slice(2);
  if (
    !certificatePath ||
    !originalPath ||
    !trustedJWKSPath ||
    !trustedIssuer ||
    flags.some(
      (f) =>
        !['--allow-development', '--allow-unanchored', '--online'].includes(f) &&
        !f.startsWith('--state='),
    )
  )
    throw new Error(
      'Usage: node --import tsx scripts/verify-proof.ts proof.json original trusted-jwks.json https://trusted-issuer [--allow-development] [--allow-unanchored] [--online] [--state=recipient-history.json]',
    );
  if ((await stat(certificatePath)).size > 131072 || (await stat(trustedJWKSPath)).size > 32768)
    throw new Error('Certificate/key file exceeds limit.');
  const bundle = proofBundleSchema.parse(JSON.parse(await readFile(certificatePath, 'utf8')));
  const trust = JSON.parse(await readFile(trustedJWKSPath, 'utf8')) as ProofTrust;
  const proof = await verifyProof(bundle, trustedIssuer, trust);
  const production =
    proof.evidence.deviceEnvironment === 'production' &&
    proof.evidence.serviceEnvironment === 'production';
  if (!production && !flags.includes('--allow-development'))
    throw new Error('DEVELOPMENT/TEST certificate. Use --allow-development only for testing.');
  const statePath = flags.find((f) => f.startsWith('--state='))?.slice(8);
  // Hold an exclusive recipient-owned lock across verification and atomic replacement.
  // A stale lock after a crash must be inspected/removed explicitly, never bypassed.
  const lock = statePath ? await open(statePath + '.lock', 'wx', 0o600) : undefined;
  try {
    let history: {
      version: number;
      proofs: Record<string, string>;
      checkpoints: Record<string, string>;
    } = { version: 1, proofs: {}, checkpoints: {} };
    if (statePath) {
      try {
        if ((await stat(statePath)).size > 1048576) throw new Error('History exceeds limit');
        history = JSON.parse(await readFile(statePath, 'utf8'));
        if (history.version !== 1 || !history.proofs || !history.checkpoints)
          throw new Error('Invalid recipient history');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const pin = hash(proof.issuer + '/' + proof.proofId);
    const certificateDigest = checkProofPin(history.proofs[pin] ?? null, bundle.certificate);
    let external: Record<string, unknown> = { state: 'unanchored' };
    if (bundle.anchors) {
      const verified = await verifyAnchors(bundle);
      const key = hash(verified.checkpoint.origin),
        prior = history.checkpoints[key];
      const current = flags.includes('--online')
        ? await checkLiveLog(verified.checkpoint, prior)
        : verified.checkpoint;
      if (prior && !flags.includes('--online')) {
        const previous = await verifyCheckpoint(prior);
        if (previous.size === current.size) verifyConsistency(previous, current, []);
      }
      // An offline old bundle is valid historical evidence, not evidence of a live rollback.
      if (!prior || flags.includes('--online')) history.checkpoints[key] = current.envelope;
      external = {
        state: 'verified',
        timestamp: verified.timestamp.time,
        timestampMeaning: 'certificate-existed-by-this-time',
        log: current.origin,
        logSize: current.size,
        continuity: flags.includes('--online')
          ? 'verified-directly-with-independent-log'
          : 'not-checked-offline',
      };
    } else if (!flags.includes('--allow-unanchored'))
      throw new Error(
        'External evidence missing/pending/stripped. Use --allow-unanchored only to verify the service signature and original.',
      );
    const metadata = await stat(originalPath);
    if (metadata.size !== proof.original.bytes || metadata.size > 512 * 1024 * 1024)
      throw new Error('Original file size mismatch.');
    const fileHash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(originalPath, { highWaterMark: 1024 * 1024 })) {
      bytes += chunk.length;
      if (bytes > proof.original.bytes) throw new Error('Original file changed while reading.');
      fileHash.update(chunk);
    }
    if (bytes !== proof.original.bytes || fileHash.digest('hex') !== proof.original.sha256)
      throw new Error('Original SHA-256 mismatch.');
    if (statePath) {
      history.proofs[pin] = certificateDigest;
      const serialized = JSON.stringify(history, null, 2);
      if (serialized.length > 1048576)
        throw new Error(
          'History exceeds limit; archive it without losing the existing trust history',
        );
      const temporary = statePath + '.' + crypto.randomUUID() + '.tmp';
      await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
      await rename(temporary, statePath);
    }
    console.log(
      JSON.stringify(
        {
          signature: 'valid',
          file: 'identical',
          proofId: proof.proofId,
          creatorId: proof.creatorId,
          environment: production ? 'production' : 'DEVELOPMENT/TEST',
          onlineStatus: 'not-checked',
          keyStatus: 'as-of-supplied-trust-file',
          external,
          recipientHistory: statePath
            ? 'retained'
            : 'not-retained; use --state for replacement detection',
          scope: proof.scope,
          subjectTruthGuaranteed: false,
          personIdentityVerified: false,
        },
        null,
        2,
      ),
    );
  } finally {
    if (lock) {
      await lock.close();
      await unlink(statePath + '.lock');
    }
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'Verification failed.');
  process.exitCode = 1;
});
