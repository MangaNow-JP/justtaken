import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { CompactSign, generateKeyPair, exportJWK } from 'jose';
import { verifyProof } from '../src/proof-verify';
import { publicProofKeys, proofIssuer } from '../src/proof-keys';
import { hashWorkerJS } from '../src/generated/verifier';
import type { Bindings } from '../src/types';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: Awaited<ReturnType<typeof exportJWK>>;
const trust: { keys: Awaited<ReturnType<typeof exportJWK>>[] } = { keys: [] };
before(async () => {
  keys = await generateKeyPair('ES256', { extractable: true });
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'key-1' };
  trust.keys = [jwk];
});
const payload = {
  version: 1,
  issuer: 'https://proof.justtaken.example',
  proofId: randomUUID(),
  creatorId: randomUUID(),
  issuedAt: '2026-10-25T03:00:03.000Z',
  deviceCapturedAt: '2026-10-25T03:00:00.000Z',
  serverCommittedAt: '2026-10-25T03:00:01.000Z',
  serverVerifiedAt: '2026-10-25T03:00:02.000Z',
  policyVersion: 'capture-v3',
  kind: 'photo',
  original: {
    id: 'original',
    role: 'original',
    mime: 'image/x-adobe-dng',
    width: 4032,
    height: 3024,
    bytes: 100000,
    sha256: 'a'.repeat(64),
    orientation: 1,
    preservation: 'camera-original',
    hasGainMap: false,
  },
  manifestDigest: 'b'.repeat(64),
  evidence: {
    method: 'apple-app-attest',
    deviceEnvironment: 'production',
    serviceEnvironment: 'production',
  },
  scope: 'app-capture-and-file-integrity',
  subjectTruthGuaranteed: false,
  personIdentityVerified: false,
};
const sign = async (p: unknown = payload, header = {}, privateKey = keys.privateKey) => ({
  format: 'justtaken-proof-v1',
  certificate: await new CompactSign(new TextEncoder().encode(JSON.stringify(p)))
    .setProtectedHeader({ alg: 'ES256', kid: 'key-1', typ: 'justtaken-proof+jws', ...header })
    .sign(privateKey),
});
test('portable certificate verifies with independently trusted issuer keys', async () => {
  assert.equal(
    (await verifyProof(await sign(), payload.issuer, trust)).original.sha256,
    payload.original.sha256,
  );
});
test('altered signed payload and wrong signing key are rejected', async () => {
  const bundle = await sign();
  const pieces = bundle.certificate.split('.');
  pieces[1] = Buffer.from(JSON.stringify({ ...payload, creatorId: randomUUID() })).toString(
    'base64url',
  );
  await assert.rejects(
    verifyProof({ ...bundle, certificate: pieces.join('.') }, payload.issuer, trust),
  );
  const attacker = await generateKeyPair('ES256');
  await assert.rejects(
    verifyProof(await sign(payload, {}, attacker.privateKey), payload.issuer, trust),
  );
});
test('file supplied JWK, jku, wrong type and unknown issuer are not trusted', async () => {
  for (const header of [
    { jwk },
    { jku: 'https://attacker.invalid/keys' },
    { typ: 'JWT' },
    { kid: 'unknown' },
  ])
    await assert.rejects(verifyProof(await sign(payload, header), payload.issuer, trust));
  await assert.rejects(verifyProof(await sign(), 'https://other.example', trust));
  await assert.rejects(verifyProof({ ...(await sign()), keys: [jwk] }, payload.issuer, trust));
});
test('revoked key and false claims are rejected', async () => {
  await assert.rejects(
    verifyProof(await sign(), payload.issuer, { ...trust, revokedKids: ['key-1'] }),
  );
  await assert.rejects(
    verifyProof(await sign({ ...payload, subjectTruthGuaranteed: true }), payload.issuer, trust),
  );
  await assert.rejects(
    verifyProof(await sign({ ...payload, personIdentityVerified: true }), payload.issuer, trust),
  );
  await assert.rejects(
    verifyProof(
      await sign({ ...payload, serverVerifiedAt: '2026-10-25T03:00:00.000Z' }),
      payload.issuer,
      trust,
    ),
  );
});
test('key rotation retains old proofs and exports only public key members', async () => {
  const next = await generateKeyPair('ES256', { extractable: true });
  const env = {
    RECEIPT_PRIVATE_JWK: JSON.stringify(await exportJWK(next.privateKey)),
    RECEIPT_KEY_ID: 'key-2',
    RECEIPT_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...jwk, d: 'never-export-this' }] }),
  } as Bindings;
  const rotated = publicProofKeys(env);
  assert.equal(rotated.keys.length, 2);
  assert.equal(JSON.stringify(rotated).includes('never-export-this'), false);
  assert.equal(
    rotated.keys.some((k) => Object.hasOwn(k, 'd')),
    false,
  );
  assert.equal((await verifyProof(await sign(), payload.issuer, rotated)).proofId, payload.proofId);
  assert.throws(() => publicProofKeys({ ...env, RECEIPT_KEY_ID: 'key-1' }));
});
test('issuer comes from configured origin; production refuses insecure origins', () => {
  assert.equal(
    proofIssuer({ API_ORIGIN: payload.issuer, ENVIRONMENT: 'production' } as Bindings),
    payload.issuer,
  );
  for (const origin of [
    'http://example.com',
    'https://example.com/path',
    'https://u:p@example.com',
  ])
    assert.throws(() => proofIssuer({ API_ORIGIN: origin, ENVIRONMENT: 'production' } as Bindings));
});
test('browser hash worker hashes whole large files in bounded chunks, without network APIs', async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 7, 0x73);
  bytes[bytes.length - 1] = 9;
  let largestRead = 0;
  const messages: any[] = [];
  const self: any = { postMessage: (data: unknown) => messages.push(data) };
  runInNewContext(hashWorkerJS, { self, Uint8Array, Uint32Array, DataView, ArrayBuffer, Error });
  await self.onmessage({
    data: {
      file: {
        size: bytes.length,
        slice(start: number, end: number) {
          largestRead = Math.max(largestRead, end - start);
          return { arrayBuffer: async () => Uint8Array.from(bytes.subarray(start, end)).buffer };
        },
      },
    },
  });
  assert.equal(messages.at(-1).sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(messages.at(-1).bytes, bytes.length);
  assert.ok(largestRead <= 1024 * 1024);
  assert.ok(messages.filter((m) => m.progress !== undefined).length > 8);
  bytes[0] ^= 1;
  assert.notEqual(messages.at(-1).sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('public certificates reject private GPS data even with a valid issuer signature', async () => {
  for (const field of ['location', 'latitudeE7', 'longitudeE7']) {
    await assert.rejects(
      verifyProof(
        await sign({ ...payload, [field]: { status: 'recorded', latitudeE7: 350000000 } }),
        payload.issuer,
        trust,
      ),
    );
  }
});
