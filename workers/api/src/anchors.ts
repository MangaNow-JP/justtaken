import { proofAnchorsSchema, type ProofBundle } from '@justtaken/contracts/proof';
import { hash, verifyAnchors } from './anchor-crypto';
import { createLogRequest, newNonce, obtainLog, obtainTimestamp } from './anchor-client';
import type { Bindings } from './types';

type AnchorRow = {
  proof_id: string;
  certificate_digest: string;
  nonce: string;
  timestamp_response: string | null;
  log_request: string | null;
  anchors: string | null;
  attempts: number;
  next_attempt: number;
  last_error: string | null;
  completed_at: string | null;
};
export const anchorsEnabled = (env: Bindings) => env.PROOF_ANCHOR_PROVIDER === 'sigstore-v1';
export async function anchoredBundle(
  env: Bindings,
  id: string,
  certificate: string,
): Promise<ProofBundle> {
  const row = await env.HOME.prepare(
    'SELECT certificate_digest,anchors FROM proof_anchors WHERE proof_id=?',
  )
    .bind(id)
    .first<AnchorRow>();
  if (row && row.certificate_digest !== hash(certificate))
    throw new Error('Stored certificate was replaced');
  return {
    format: 'justtaken-proof-v1',
    certificate,
    ...(row?.anchors ? { anchors: proofAnchorsSchema.parse(JSON.parse(row.anchors)) } : {}),
  };
}
export async function enqueueAnchor(env: Bindings, id: string, certificate: string) {
  if (!anchorsEnabled(env)) return;
  await env.HOME.prepare(
    'INSERT INTO proof_anchors(proof_id,certificate_digest,nonce) VALUES(?,?,?) ON CONFLICT(proof_id) DO NOTHING',
  )
    .bind(id, hash(certificate), newNonce())
    .run();
}
export async function anchorStatus(env: Bindings, id: string, certificate: string) {
  const row = await env.HOME.prepare('SELECT * FROM proof_anchors WHERE proof_id=?')
    .bind(id)
    .first<AnchorRow>();
  if (row && row.certificate_digest !== hash(certificate)) return { state: 'mismatch' as const };
  if (!row)
    return {
      state: anchorsEnabled(env) ? ('not-requested' as const) : ('not-configured' as const),
    };
  return {
    state: row.anchors ? ('anchored' as const) : ('pending' as const),
    attempts: row.attempts,
    retryAt: row.next_attempt,
    completedAt: row.completed_at,
  };
}
export async function processAnchor(env: Bindings, id: string) {
  if (!anchorsEnabled(env)) return;
  const now = Date.now(),
    lease = crypto.randomUUID();
  const row = await env.HOME.prepare(
    `UPDATE proof_anchors SET lease_id=?,lease_until=?,attempts=attempts+1 WHERE proof_id=? AND anchors IS NULL AND lease_until<? AND next_attempt<=? RETURNING *`,
  )
    .bind(lease, now + 120_000, id, now, now)
    .first<AnchorRow>();
  if (!row) return;
  let stage = 'SOURCE';
  try {
    const proof = await env.HOME.prepare('SELECT certificate FROM capture_proofs WHERE proof_id=?')
      .bind(id)
      .first<{ certificate: string }>();
    if (!proof || row.certificate_digest !== hash(proof.certificate))
      throw new Error('Certificate mismatch');
    // Keep the exact nonce, timestamp and signed log request across crashes/retries.
    let timestamp = row.timestamp_response;
    stage = 'TIMESTAMP';
    if (!timestamp) {
      timestamp = await obtainTimestamp(proof.certificate, row.nonce);
      const saved = await env.HOME.prepare(
        'UPDATE proof_anchors SET timestamp_response=? WHERE proof_id=? AND lease_id=?',
      )
        .bind(timestamp, id, lease)
        .run();
      if (!saved.meta.changes) return;
    }
    let request = row.log_request;
    stage = 'LOG_REQUEST';
    if (!request) {
      if (!env.RECEIPT_PRIVATE_JWK) throw new Error('Signing key unavailable');
      request = await createLogRequest(
        proof.certificate,
        timestamp,
        JSON.parse(env.RECEIPT_PRIVATE_JWK),
      );
      const saved = await env.HOME.prepare(
        'UPDATE proof_anchors SET log_request=? WHERE proof_id=? AND lease_id=?',
      )
        .bind(request, id, lease)
        .run();
      if (!saved.meta.changes) return;
    }
    stage = 'LOG';
    const log = await obtainLog(proof.certificate, timestamp, request);
    const anchors = proofAnchorsSchema.parse({
      version: 1,
      provider: 'sigstore-v1',
      nonce: row.nonce,
      timestamp,
      log,
    });
    stage = 'VERIFY';
    await verifyAnchors({ format: 'justtaken-proof-v1', certificate: proof.certificate, anchors });
    await env.HOME.prepare(
      `UPDATE proof_anchors SET anchors=?,completed_at=?,lease_until=0,lease_id=NULL,last_error=NULL WHERE proof_id=? AND lease_id=? AND certificate_digest=? AND EXISTS(SELECT 1 FROM capture_proofs WHERE proof_id=? AND certificate=?)`,
    )
      .bind(
        JSON.stringify(anchors),
        new Date().toISOString(),
        id,
        lease,
        hash(proof.certificate),
        id,
        proof.certificate,
      )
      .run();
  } catch {
    // Do not persist third-party response bodies, signed material or request identifiers in logs.
    const delay = Math.min(86400_000, 60_000 * 2 ** Math.min(row.attempts, 10));
    await env.HOME.prepare(
      'UPDATE proof_anchors SET lease_until=0,lease_id=NULL,next_attempt=?,last_error=? WHERE proof_id=? AND lease_id=?',
    )
      .bind(Date.now() + delay, stage + '_UNAVAILABLE', id, lease)
      .run();
  }
}
export async function retryAnchors(env: Bindings) {
  if (!anchorsEnabled(env)) return;
  const rows = await env.HOME.prepare(
    'SELECT proof_id FROM proof_anchors WHERE anchors IS NULL AND next_attempt<=? AND lease_until<? ORDER BY next_attempt LIMIT 5',
  )
    .bind(Date.now(), Date.now())
    .all<{ proof_id: string }>();
  await Promise.all(rows.results.map((row) => processAnchor(env, row.proof_id)));
}
