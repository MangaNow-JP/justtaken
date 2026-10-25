import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sha256 } from '@noble/hashes/sha256';
import { proofBundleSchema } from '@justtaken/contracts/proof';
import { sigstoreTrust } from '../src/anchor-trust';
import {
  verifyAnchors,
  verifyTimestamp,
  verifyLog,
  verifyCheckpoint,
  verifyInclusion,
  verifyConsistency,
  checkProofPin,
  hash,
  hex,
  b64,
  unb64,
  utf8,
  type Checkpoint,
} from '../src/anchor-crypto';
import { boundedResponse } from '../src/anchor-client';
import { CompactSign, generateKeyPair, exportJWK } from 'jose';
import { verifyProof } from '../src/proof-verify';
const fixture = async () =>
  proofBundleSchema.parse(
    JSON.parse(await readFile(new URL('./fixtures/external-anchor.json', import.meta.url), 'utf8')),
  );

test('real third-party RFC3161 signature, ESS binding, log SET, checkpoint and inclusion verify offline', async () => {
  const bundle = await fixture();
  const result = await verifyAnchors(bundle);
  assert.equal(result.timestamp.time, '2026-10-25T12:28:07.000Z');
  assert.ok(result.checkpoint.size > 2 ** 31); // No signed 32-bit bitwise truncation.
  assert.equal(result.checkpoint.origin, 'rekor.sigstore.dev - 1193050959916656506');
  const body = JSON.parse(new TextDecoder().decode(unb64(bundle.anchors!.log.body)));
  assert.equal(body.kind, 'hashedrekord');
  const encoded = JSON.stringify(body);
  for (const field of ['proofId', 'creatorId', 'deviceCapturedAt', 'image/heic', 'certificate'])
    assert.equal(encoded.includes(field), false);
});
test('TSA rejects altered data, nonce, signature, self-supplied trust and future trust interval', async () => {
  const b = await fixture(),
    a = b.anchors!;
  await assert.rejects(verifyTimestamp(b.certificate + 'x', a.timestamp, a.nonce));
  await assert.rejects(verifyTimestamp(b.certificate, a.timestamp, '01'.repeat(16)));
  const corrupted = unb64(a.timestamp);
  corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(verifyTimestamp(b.certificate, b64(corrupted), a.nonce));
  await assert.rejects(
    verifyTimestamp(b.certificate, a.timestamp, a.nonce, {
      ...sigstoreTrust,
      tsaCertificates: [sigstoreTrust.tsaCertificates[1]],
    }),
  );
  await assert.rejects(
    verifyTimestamp(b.certificate, a.timestamp, a.nonce, {
      ...sigstoreTrust,
      tsaStart: '2099-01-01T00:00:00Z',
    }),
  );
  await assert.rejects(verifyTimestamp(b.certificate, a.timestamp + 'AAAA', a.nonce));
});
test('log evidence rejects substitutions, index/root/time changes, altered checkpoint and paths', async () => {
  const b = await fixture(),
    a = b.anchors!;
  const mutations: ((entry: typeof a.log) => void)[] = [
    (e) => {
      e.logIndex++;
    },
    (e) => {
      e.integratedTime--;
    },
    (e) => {
      e.logID = 'a'.repeat(64);
    },
    (e) => {
      e.verification.inclusionProof.rootHash = 'b'.repeat(64);
    },
    (e) => {
      e.verification.inclusionProof.treeSize++;
    },
    (e) => {
      e.verification.inclusionProof.logIndex++;
    },
    (e) => {
      e.verification.inclusionProof.hashes[0] = 'c'.repeat(64);
    },
    (e) => {
      e.verification.inclusionProof.hashes.push('d'.repeat(64));
    },
    (e) => {
      e.verification.inclusionProof.checkpoint = e.verification.inclusionProof.checkpoint.replace(
        'rekor.sigstore.dev -',
        'evil.sigstore.dev -',
      );
    },
    (e) => {
      const bytes = unb64(e.body);
      bytes[bytes.length - 2] ^= 1;
      e.body = b64(bytes);
    },
  ];
  for (const mutate of mutations) {
    const entry = structuredClone(a.log);
    mutate(entry);
    await assert.rejects(verifyLog(b.certificate, a.timestamp, entry));
  }
  await assert.rejects(verifyLog(b.certificate + 'resigned-different-content', a.timestamp, a.log));
  await assert.rejects(verifyAnchors({ ...b, anchors: undefined }));
});
test('previously accepted proof pins detect an operator re-signing the same proof ID', async () => {
  const b = await fixture();
  const pin = checkProofPin(null, b.certificate);
  assert.equal(pin, hash(b.certificate));
  assert.equal(checkProofPin(pin, b.certificate), pin);
  assert.throws(() => checkProofPin(pin, b.certificate + 'newly-valid-service-signature'));
  const payload = JSON.parse(Buffer.from(b.certificate.split('.')[1], 'base64url').toString());
  const keys = await generateKeyPair('ES256', { extractable: true });
  const replacement = await new CompactSign(
    utf8(JSON.stringify({ ...payload, deviceCapturedAt: '2026-01-01T00:00:00.000Z' })),
  )
    .setProtectedHeader({ alg: 'ES256', kid: 'operator-new-key', typ: 'justtaken-proof+jws' })
    .sign(keys.privateKey);
  const changed = { ...b, certificate: replacement };
  const verified = await verifyProof(changed, payload.issuer, {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'operator-new-key' }],
  });
  assert.equal(verified.proofId, payload.proofId); // A fresh operator signature alone passes.
  assert.throws(() => checkProofPin(pin, changed.certificate));
  await assert.rejects(verifyAnchors(changed));
});

const leaves = Array.from({ length: 257 }, (_, i) => utf8('unique leaf ' + i));
const lh = (b: Uint8Array) => sha256(new Uint8Array([0, ...b]));
const nh = (a: Uint8Array, b: Uint8Array) => sha256(new Uint8Array([1, ...a, ...b]));
const split = (n: number) => 2 ** Math.floor(Math.log2(n - 1));
function root(start: number, n: number): Uint8Array {
  if (n === 1) return lh(leaves[start]);
  const k = split(n);
  return nh(root(start, k), root(start + k, n - k));
}
function inclusion(index: number, start: number, n: number): string[] {
  if (n === 1) return [];
  const k = split(n);
  return index < k
    ? [...inclusion(index, start, k), hex(root(start + k, n - k))]
    : [...inclusion(index - k, start + k, n - k), hex(root(start, k))];
}
function consistency(m: number, start: number, n: number, complete = true): string[] {
  if (m === n) return complete ? [] : [hex(root(start, n))];
  const k = split(n);
  return m <= k
    ? [...consistency(m, start, k, complete), hex(root(start + k, n - k))]
    : [...consistency(m - k, start + k, n - k, false), hex(root(start, k))];
}
const checkpoint = (n: number): Checkpoint => ({
  origin: 'test - 1',
  size: n,
  root: hex(root(0, n)),
  envelope: '',
});
test('RFC6962 inclusion and consistency across balanced and unbalanced trees', () => {
  for (const n of [...Array.from({ length: 64 }, (_, i) => i + 1), 129, 257]) {
    for (let i = 0; i < n; i++) verifyInclusion(leaves[i], i, checkpoint(n), inclusion(i, 0, n));
    for (let m = 1; m <= n; m++)
      verifyConsistency(checkpoint(m), checkpoint(n), consistency(m, 0, n));
  }
});
test('fork, rollback, unrelated shard, truncated or forged consistency proofs fail closed', () => {
  assert.throws(() => verifyConsistency({ ...checkpoint(1), size: 0 }, checkpoint(7), []));
  assert.throws(() => verifyConsistency(checkpoint(1), { ...checkpoint(7), size: Number.MAX_SAFE_INTEGER + 1 }, []));
  assert.throws(() => verifyConsistency(checkpoint(8), checkpoint(7), []));
  assert.throws(() =>
    verifyConsistency(checkpoint(8), { ...checkpoint(8), root: 'a'.repeat(64) }, []),
  );
  assert.throws(() =>
    verifyConsistency(checkpoint(8), { ...checkpoint(9), origin: 'other' }, consistency(8, 0, 9)),
  );
  assert.throws(() =>
    verifyConsistency(checkpoint(5), checkpoint(13), consistency(5, 0, 13).slice(1)),
  );
  const p = consistency(5, 0, 13);
  p[0] = 'f'.repeat(64);
  assert.throws(() => verifyConsistency(checkpoint(5), checkpoint(13), p));
  assert.throws(() => verifyInclusion(leaves[0], 9, checkpoint(9), []));
  assert.throws(() => verifyInclusion(leaves[0], 0, checkpoint(9), inclusion(0, 0, 9).slice(1)));
});
test('bounded service responses cannot expand indefinitely', async () => {
  assert.equal((await boundedResponse(new Response('1234'), 4)).length, 4);
  await assert.rejects(boundedResponse(new Response('12345'), 4));
  await assert.rejects(boundedResponse(new Response('provider failure', { status: 503 })));
});
test('proof contracts reject untrusted anchor URLs and extra embedded trust material', async () => {
  const b = await fixture();
  assert.throws(() =>
    proofBundleSchema.parse({
      ...b,
      anchors: { ...b.anchors, tsaURL: 'https://attacker.invalid' },
    }),
  );
  assert.throws(() =>
    proofBundleSchema.parse({ ...b, anchors: { ...b.anchors, trust: sigstoreTrust } }),
  );
  await assert.rejects(
    verifyCheckpoint(b.anchors!.log.verification.inclusionProof.checkpoint + 'unparsed garbage'),
  );
});
