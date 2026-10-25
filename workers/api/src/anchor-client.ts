import { logEntrySchema, type ProofAnchors } from '@justtaken/contracts/proof';
import {
  anchorPayload,
  b64,
  derSignature,
  hash,
  hex,
  timestampRequest,
  utf8,
  verifyCheckpoint,
  verifyConsistency,
  verifyLog,
  verifyTimestamp,
  type Checkpoint,
} from './anchor-crypto';
import { sigstoreTrust, type AnchorTrust } from './anchor-trust';

export class AnchorNetworkError extends Error {}
export async function boundedResponse(response: Response, max = 65536) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new AnchorNetworkError('Independent service unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new Error('Independent response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function externalFetch(url: string, init: RequestInit = {}) {
  try {
    // workerd supports manual/follow only. Never follow redirects carrying a commitment.
    const response = await fetch(url, {
      ...init,
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20000),
    });
    if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
      await response.body?.cancel();
      throw new AnchorNetworkError('Independent service redirected');
    }
    return response;
  } catch (cause) {
    throw new AnchorNetworkError('Independent service unreachable', { cause });
  }
}
export function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] &= 0x7f;
  bytes[0] |= 1;
  return hex(bytes);
}
export async function obtainTimestamp(
  certificate: string,
  nonce: string,
  trust: AnchorTrust = sigstoreTrust,
) {
  const response = await externalFetch(trust.tsaURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/timestamp-query',
      Accept: 'application/timestamp-reply, application/timestamp-response',
    },
    body: timestampRequest(certificate, nonce),
  });
  const timestamp = b64(await boundedResponse(response, 32768));
  await verifyTimestamp(certificate, timestamp, nonce, trust);
  return timestamp;
}
export async function createLogRequest(
  certificate: string,
  timestamp: string,
  privateJWK: JsonWebKey,
) {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const { d: _private, key_ops: _ops, ...publicJWK } = privateJWK;
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const spki = b64(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));
  const pem =
    '-----BEGIN PUBLIC KEY-----\n' +
    spki.match(/.{1,64}/g)!.join('\n') +
    '\n-----END PUBLIC KEY-----\n';
  const payload = anchorPayload(certificate, timestamp);
  const signature = derSignature(
    new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload)),
  );
  return JSON.stringify({
    apiVersion: '0.0.1',
    kind: 'hashedrekord',
    spec: {
      data: { hash: { algorithm: 'sha256', value: hash(payload) } },
      signature: { content: b64(signature), publicKey: { content: b64(utf8(pem)) } },
    },
  });
}
export async function obtainLog(
  certificate: string,
  timestamp: string,
  request: string,
  trust: AnchorTrust = sigstoreTrust,
): Promise<ProofAnchors['log']> {
  let response = await externalFetch(trust.logURL + '/api/v1/log/entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: request,
  });
  if (response.status === 409) {
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (!location) throw new Error('Missing duplicate log location');
    const url = new URL(location, trust.logURL);
    if (
      url.origin !== new URL(trust.logURL).origin ||
      !/^\/api\/v1\/log\/entries\/(?:[a-f0-9]{64}|[a-f0-9]{80})$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('Untrusted log location');
    response = await externalFetch(url.href);
  }
  const entries = Object.values(
    JSON.parse(new TextDecoder().decode(await boundedResponse(response))),
  );
  if (entries.length !== 1) throw new Error('Expected one log entry');
  const entry = logEntrySchema.parse(entries[0]);
  await verifyLog(certificate, timestamp, entry, trust);
  return entry;
}
export async function checkConsistency(
  older: Checkpoint,
  newer: Checkpoint,
  trust: AnchorTrust = sigstoreTrust,
) {
  if (older.origin !== newer.origin || older.size >= newer.size) {
    verifyConsistency(older, newer, []);
    return;
  }
  const treeID = older.origin.split(' - ')[1];
  const url =
    trust.logURL +
    '/api/v1/log/proof?' +
    new URLSearchParams({ firstSize: String(older.size), lastSize: String(newer.size), treeID });
  const response = JSON.parse(
    new TextDecoder().decode(await boundedResponse(await externalFetch(url), 16384)),
  );
  if (!Array.isArray(response.hashes)) throw new Error('Missing consistency proof');
  verifyConsistency(older, newer, response.hashes);
}
// Direct recipient-to-log requests: operator proxies cannot substitute the current checkpoint.
export async function checkLiveLog(
  included: Checkpoint,
  priorEnvelope?: string,
  trust: AnchorTrust = sigstoreTrust,
) {
  const info = JSON.parse(
    new TextDecoder().decode(
      await boundedResponse(await externalFetch(trust.logURL + '/api/v1/log'), 65536),
    ),
  );
  const candidates = [info, ...(Array.isArray(info.inactiveShards) ? info.inactiveShards : [])];
  let current: Checkpoint | undefined;
  for (const candidate of candidates) {
    if (
      typeof candidate.signedTreeHead !== 'string' ||
      !candidate.signedTreeHead.startsWith(included.origin + '\n')
    )
      continue;
    current = await verifyCheckpoint(candidate.signedTreeHead, trust);
    break;
  }
  if (!current) throw new Error('Log tree is missing');
  await checkConsistency(included, current, trust);
  if (priorEnvelope)
    await checkConsistency(await verifyCheckpoint(priorEnvelope, trust), current, trust);
  return current;
}
