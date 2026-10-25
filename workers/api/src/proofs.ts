import { CompactSign, importJWK } from 'jose';
import { manifestDigest } from '@justtaken/contracts';
import { proofSchema, type ProofBundle } from '@justtaken/contracts/proof';
import { mediaExtension } from '@justtaken/contracts/policy';
import { bodyJSON, fail, json, requireValue, sha, token, unwrap, validID } from './http';
import { proofIssuer, publicProofKeys } from './proof-keys';
import { verifyProof } from './proof-verify';
import { anchoredBundle, anchorStatus, enqueueAnchor, processAnchor } from './anchors';
import { verifyAnchors } from './anchor-crypto';
import { originalKey } from './media';
import type { Bindings, Principal } from './types';

type ProofRow = {
  sequence: number;
  proof_id: string;
  capture_id: string;
  installation_id: string;
  owner_id: string;
  certificate: string;
  created_at: string;
};
const bundle = (env: Bindings, row: ProofRow): Promise<ProofBundle> =>
  anchoredBundle(env, row.proof_id, row.certificate);
async function owned(env: Bindings, user: string, id: string) {
  const row = await env.HOME.prepare('SELECT * FROM capture_proofs WHERE proof_id=? AND owner_id=?')
    .bind(id, user)
    .first<ProofRow>();
  if (!row) fail(404, 'PROOF_NOT_FOUND', '撮影証明が見つかりません。');
  return row;
}
async function available(env: Bindings, row: ProofRow) {
  const profile = await env.HOME.prepare(
    'SELECT status,proof_creator_id FROM profiles WHERE user_id=?',
  )
    .bind(row.owner_id)
    .first<{ status: string; proof_creator_id: string }>();
  if (profile?.status !== 'ACTIVE')
    fail(410, 'PROOF_UNAVAILABLE', 'この撮影証明は利用できません。');
  const source = unwrap(
    await env.CAPTURE.getByName(row.installation_id).proofSource(row.owner_id, row.capture_id),
  );
  // Removed signing keys and explicitly revoked keys fail closed for online access.
  const evidence = await bundle(env, row);
  const proof = await verifyProof(evidence, proofIssuer(env), publicProofKeys(env));
  if (evidence.anchors) await verifyAnchors(evidence);
  if (
    proof.proofId !== row.proof_id ||
    proof.creatorId !== profile.proof_creator_id ||
    proof.manifestDigest !== source.capture.digest ||
    proof.manifestDigest !== (await manifestDigest(source.capture.manifest!)) ||
    JSON.stringify(proof.original) !==
      JSON.stringify(proofSchema.shape.original.parse(source.capture.manifest!.assets[0])) ||
    proof.kind !== source.capture.manifest!.kind ||
    proof.policyVersion !== source.capture.manifest!.policyVersion ||
    proof.deviceCapturedAt !== source.capture.manifest!.clientCapturedAt ||
    proof.serverCommittedAt !== source.capture.committedAt ||
    proof.serverVerifiedAt !== source.capture.verifiedAt ||
    proof.issuedAt !== row.created_at ||
    proof.evidence.method !==
      (source.platform === 'ios' ? 'apple-app-attest' : 'google-play-integrity') ||
    proof.evidence.deviceEnvironment !== source.environment
  )
    fail(409, 'PROOF_MISMATCH', '証明と撮影記録が一致しません。');
  return { source, proof };
}

export async function publicProofRoutes(
  request: Request,
  env: Bindings,
): Promise<Response | undefined> {
  const match = /^\/public\/proof-shares\/([A-Za-z0-9_-]{36})$/.exec(new URL(request.url).pathname);
  if (!match || request.method !== 'POST') return;
  const secret = request.headers.get('X-Proof-Token');
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret))
    fail(404, 'SHARE_UNAVAILABLE', '共有リンクが無効、期限切れ、または停止されています。');
  const hash = await sha(secret);
  const query = () =>
    env.HOME.prepare(
      `SELECT p.*, s.expires_at FROM proof_shares s
    JOIN capture_proofs p ON p.proof_id=s.proof_id
    WHERE s.share_id=? AND s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`,
    )
      .bind(match[1], hash, Date.now())
      .first<ProofRow & { expires_at: number }>();
  const row = await query();
  if (!row) fail(404, 'SHARE_UNAVAILABLE', '共有リンクが無効、期限切れ、または停止されています。');
  await available(env, row);
  // Recheck revocation after the external Durable Object/crypto awaits.
  if (!(await query())) fail(404, 'SHARE_UNAVAILABLE', '共有リンクは停止されています。');
  return json({
    bundle: await bundle(env, row),
    expiresAt: row.expires_at,
    checkedAt: new Date().toISOString(),
  });
}

export async function proofRoutes(
  request: Request,
  env: Bindings,
  principal: Principal,
): Promise<Response | undefined> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method,
    user = principal.userId;
  if (path === '/v1/proofs' && method === 'POST') {
    const data = await bodyJSON(request, 4096);
    if (!validID(data.installationId) || !validID(data.captureId))
      fail(400, 'INVALID_CAPTURE', '撮影記録を選んでください。');
    const object = env.CAPTURE.getByName(data.installationId);
    const source = unwrap(await object.proofSource(user, data.captureId)),
      s = source.capture;
    let row = await env.HOME.prepare(
      'SELECT * FROM capture_proofs WHERE capture_id=? AND owner_id=?',
    )
      .bind(data.captureId, user)
      .first<ProofRow>();
    if (!row) {
      await env.HOME.prepare(
        'UPDATE profiles SET proof_creator_id=COALESCE(proof_creator_id,?) WHERE user_id=?',
      )
        .bind(crypto.randomUUID(), user)
        .run();
      const profile = await env.HOME.prepare(
        'SELECT proof_creator_id FROM profiles WHERE user_id=?',
      )
        .bind(user)
        .first<{ proof_creator_id: string }>();
      requireValue(profile?.proof_creator_id && env.RECEIPT_PRIVATE_JWK && env.RECEIPT_KEY_ID);
      requireValue(!publicProofKeys(env).revokedKids?.includes(env.RECEIPT_KEY_ID));
      const proof = proofSchema.parse({
        version: 1,
        issuer: proofIssuer(env),
        proofId: crypto.randomUUID(),
        creatorId: profile.proof_creator_id,
        issuedAt: new Date().toISOString(),
        deviceCapturedAt: s.manifest!.clientCapturedAt,
        serverCommittedAt: s.committedAt,
        serverVerifiedAt: s.verifiedAt,
        policyVersion: s.manifest!.policyVersion,
        kind: s.manifest!.kind,
        original: s.manifest!.assets[0],
        manifestDigest: s.digest,
        evidence: {
          method: source.platform === 'ios' ? 'apple-app-attest' : 'google-play-integrity',
          deviceEnvironment: source.environment,
          serviceEnvironment: env.ENVIRONMENT,
        },
        scope: 'app-capture-and-file-integrity',
        subjectTruthGuaranteed: false,
        personIdentityVerified: false,
        anchorPolicy: 'rfc3161-rekor-v1',
      });
      const key = await importJWK(JSON.parse(env.RECEIPT_PRIVATE_JWK), 'ES256');
      const certificate = await new CompactSign(new TextEncoder().encode(JSON.stringify(proof)))
        .setProtectedHeader({ alg: 'ES256', kid: env.RECEIPT_KEY_ID, typ: 'justtaken-proof+jws' })
        .sign(key);
      unwrap(await object.proofSource(user, data.captureId));
      await env.HOME.prepare(
        `INSERT INTO capture_proofs(proof_id,capture_id,installation_id,owner_id,certificate,created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(capture_id) DO NOTHING`,
      )
        .bind(proof.proofId, data.captureId, data.installationId, user, certificate, proof.issuedAt)
        .run();
      row = await env.HOME.prepare('SELECT * FROM capture_proofs WHERE capture_id=? AND owner_id=?')
        .bind(data.captureId, user)
        .first<ProofRow>();
    }
    requireValue(row);
    const { proof } = await available(env, row);
    await enqueueAnchor(env, row.proof_id, row.certificate);
    await processAnchor(env, row.proof_id);
    // Recheck lifecycle and stored proof after external network calls.
    await available(env, row);
    return json(
      {
        proof,
        bundle: await bundle(env, row),
        anchoring: await anchorStatus(env, row.proof_id, row.certificate),
      },
      201,
    );
  }
  if (path === '/v1/proofs' && method === 'GET') {
    const before = url.searchParams.get('before');
    if (before && !/^[1-9][0-9]{0,14}$/.test(before))
      fail(400, 'INVALID_CURSOR', '一覧を読み直してください。');
    const rows = await env.HOME.prepare(
      'SELECT * FROM capture_proofs WHERE owner_id=? AND sequence<? ORDER BY sequence DESC LIMIT 21',
    )
      .bind(user, before ? Number(before) : Number.MAX_SAFE_INTEGER)
      .all<ProofRow>();
    const proofs = await Promise.all(
      rows.results.slice(0, 20).map(async (row) => {
        // A cancelled capture remains listed, but cannot acquire a share or export media.
        const status = unwrap(
          await env.CAPTURE.getByName(row.installation_id).status(user, row.capture_id),
        );
        const payload = proofSchema.parse(
          JSON.parse(atob(row.certificate.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))),
        );
        const shares = await env.HOME.prepare(
          'SELECT COUNT(*) AS count FROM proof_shares WHERE proof_id=? AND revoked_at IS NULL AND expires_at>?',
        )
          .bind(row.proof_id, Date.now())
          .first<{ count: number }>();
        return {
          proof: payload,
          available: status.state === 'VERIFIED',
          activeShares: shares?.count ?? 0,
          anchoring: await anchorStatus(env, row.proof_id, row.certificate),
        };
      }),
    );
    return json({
      proofs,
      nextCursor: rows.results.length > 20 ? String(rows.results[19].sequence) : null,
    });
  }
  const match = /^\/v1\/proofs\/([A-Za-z0-9_-]{36})(?:\/(shares|original|anchor|location))?$/.exec(
    path,
  );
  if (!match) return;
  const row = await owned(env, user, match[1]);
  if (match[2] === 'shares' && method === 'DELETE') {
    await env.HOME.prepare(
      'UPDATE proof_shares SET revoked_at=? WHERE proof_id=? AND revoked_at IS NULL',
    )
      .bind(Date.now(), row.proof_id)
      .run();
    return json({ revoked: true });
  }
  if (!match[2] && method === 'DELETE') {
    unwrap(await env.CAPTURE.getByName(row.installation_id).cancel(user, row.capture_id));
    await env.HOME.prepare(
      'UPDATE proof_shares SET revoked_at=? WHERE proof_id=? AND revoked_at IS NULL',
    )
      .bind(Date.now(), row.proof_id)
      .run();
    return json({ deleted: true });
  }
  const { source, proof } = await available(env, row);
  // Owner-only route. Location is bound to the attested manifest digest, but is
  // deliberately excluded from public certificates, shares, logs and originals.
  if (match[2] === 'location' && method === 'GET')
    return json({ location: source.capture.manifest!.location ?? null });
  if (!match[2] && method === 'GET')
    return json({
      proof,
      bundle: await bundle(env, row),
      anchoring: await anchorStatus(env, row.proof_id, row.certificate),
    });
  if (match[2] === 'anchor' && method === 'POST') {
    await enqueueAnchor(env, row.proof_id, row.certificate);
    await processAnchor(env, row.proof_id);
    await available(env, row);
    return json({
      proof,
      bundle: await bundle(env, row),
      anchoring: await anchorStatus(env, row.proof_id, row.certificate),
    });
  }
  if (match[2] === 'shares' && method === 'POST') {
    const data = await bodyJSON(request, 4096),
      days = data.days ?? 7;
    if (![1, 7, 30].includes(days))
      fail(400, 'INVALID_EXPIRY', '共有期限は1・7・30日から選んでください。');
    const now = Date.now(),
      id = crypto.randomUUID(),
      secret = token(),
      expiresAt = now + days * 86400_000;
    // Bounded per-proof active links; expired/revoked tokens carry no audit value.
    await env.HOME.prepare(
      'DELETE FROM proof_shares WHERE proof_id=? AND (expires_at<=? OR revoked_at IS NOT NULL)',
    )
      .bind(row.proof_id, now)
      .run();
    const inserted = await env.HOME.prepare(
      `INSERT INTO proof_shares(share_id,proof_id,token_hash,expires_at,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM proof_shares WHERE proof_id=?)<20`,
    )
      .bind(id, row.proof_id, await sha(secret), expiresAt, now, row.proof_id)
      .run();
    if (!inserted.meta.changes)
      fail(429, 'TOO_MANY_SHARES', '既存の共有リンクを停止してから作成してください。');
    return json({ url: proofIssuer(env) + '/verify#' + id + '.' + secret, expiresAt }, 201);
  }
  if (match[2] === 'original' && (method === 'GET' || method === 'HEAD')) {
    const a = source.capture.manifest!.assets[0];
    const object = await env.ORIGINALS.get(originalKey(row.installation_id, row.capture_id, a));
    if (!object) fail(404, 'ORIGINAL_NOT_FOUND', '原本が見つかりません。');
    const headers = {
      'Content-Type': a.mime,
      'Content-Length': String(a.bytes),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="JustTaken-${row.proof_id}.${mediaExtension(a.mime)}"`,
    };
    if (method === 'HEAD') {
      await object.body.cancel();
      return new Response(null, { headers });
    }
    return new Response(object.body, { headers });
  }
}
