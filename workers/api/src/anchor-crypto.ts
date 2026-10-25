import * as asn1 from 'asn1js';
import {
  Certificate,
  CryptoEngine,
  ExtKeyUsage,
  SignedData,
  TimeStampReq,
  TimeStampResp,
  TSTInfo,
  MessageImprint,
  AlgorithmIdentifier,
  createCMSECDSASignature,
  createECDSASignatureFromCMS,
} from 'pkijs';
import { sha256 } from '@noble/hashes/sha256';
import {
  proofAnchorsSchema,
  type ProofBundle,
  type ProofAnchors,
} from '@justtaken/contracts/proof';
import { sigstoreTrust, type AnchorTrust } from './anchor-trust';

export const utf8 = (s: string) => new TextEncoder().encode(s);
export const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const hash = (s: string | Uint8Array) => hex(sha256(typeof s === 'string' ? utf8(s) : s));
export const unhex = (s: string) => {
  if (!/^(?:[a-f0-9]{2})+$/.test(s)) throw new Error('Invalid hex');
  return Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
};
export const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));
export const unb64 = (s: string) => {
  if (
    s.length > 65536 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)
  )
    throw new Error('Invalid base64');
  const b = Uint8Array.from(atob(s), (x) => x.charCodeAt(0));
  if (b64(b) !== s) throw new Error('Non-canonical base64');
  return b;
};
const parseASN = (bytes: Uint8Array) => {
  const parsed = asn1.fromBER(bytes);
  if (parsed.offset !== bytes.length || parsed.result.error) throw new Error('Invalid ASN.1');
  return parsed.result;
};
const engine = () =>
  new CryptoEngine({
    name: 'JustTaken',
    crypto: globalThis.crypto,
    subtle: globalThis.crypto.subtle,
  });
export const derSignature = (raw: Uint8Array) =>
  new Uint8Array(createCMSECDSASignature(Uint8Array.from(raw).buffer));
const rawSignature = (der: Uint8Array) =>
  new Uint8Array(createECDSASignatureFromCMS(parseASN(der), 32));
export async function verifyEC(keyDER: string, signature: string, bytes: Uint8Array) {
  const key = await crypto.subtle.importKey(
    'spki',
    unb64(keyDER),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  if (
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      rawSignature(unb64(signature)),
      Uint8Array.from(bytes),
    ))
  )
    throw new Error('Invalid ECDSA signature');
}
export function timestampRequest(certificate: string, nonce: string) {
  return new TimeStampReq({
    version: 1,
    certReq: true,
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),
      hashedMessage: new asn1.OctetString({ valueHex: sha256(utf8(certificate)) }),
    }),
    nonce: new asn1.Integer({ valueHex: unhex(nonce) }),
  })
    .toSchema()
    .toBER(false);
}
export async function verifyTimestamp(
  certificate: string,
  timestamp: string,
  nonce: string,
  trust: AnchorTrust = sigstoreTrust,
) {
  const response = new TimeStampResp({ schema: parseASN(unb64(timestamp)) });
  if (
    ![0, 1].includes(response.status.status) ||
    !response.timeStampToken ||
    response.timeStampToken.contentType !== '1.2.840.113549.1.7.2'
  )
    throw new Error('TSA did not grant a timestamp');
  const cms = new SignedData({ schema: response.timeStampToken.content });
  if (
    cms.signerInfos.length !== 1 ||
    cms.encapContentInfo.eContentType !== '1.2.840.113549.1.9.16.1.4' ||
    !cms.encapContentInfo.eContent ||
    (cms.certificates?.length ?? 0) > 8
  )
    throw new Error('Invalid timestamp content');
  if (
    !['2.16.840.1.101.3.4.2.1', '2.16.840.1.101.3.4.2.2', '2.16.840.1.101.3.4.2.3'].includes(
      cms.signerInfos[0].digestAlgorithm.algorithmId,
    ) ||
    !['1.2.840.10045.4.3.2', '1.2.840.10045.4.3.3', '1.2.840.10045.4.3.4'].includes(
      cms.signerInfos[0].signatureAlgorithm.algorithmId,
    )
  )
    throw new Error('Unsupported TSA signature algorithm');
  for (const oid of ['1.2.840.113549.1.9.3', '1.2.840.113549.1.9.4']) {
    if (cms.signerInfos[0].signedAttrs?.attributes.filter((a) => a.type === oid).length !== 1)
      throw new Error('Missing or duplicate CMS attribute');
  }
  const info = new TSTInfo({
    schema: parseASN(new Uint8Array(cms.encapContentInfo.eContent.getValue())),
  });
  if (
    info.version !== 1 ||
    info.messageImprint.hashAlgorithm.algorithmId !== '2.16.840.1.101.3.4.2.1' ||
    hex(info.messageImprint.hashedMessage.valueBlock.valueHexView) !== hash(certificate) ||
    !info.nonce ||
    hex(info.nonce.valueBlock.valueHexView) !== nonce
  )
    throw new Error('Timestamp imprint or nonce mismatch');
  const time = info.genTime.getTime();
  if (!Number.isFinite(time) || time < Date.parse(trust.tsaStart) || time > Date.now() + 300_000)
    throw new Error('Timestamp time outside trust window');
  const trusted = trust.tsaCertificates.map((s) => new Certificate({ schema: parseASN(unb64(s)) }));
  // Pin both the reviewed TSA leaf and its root; an embedded self-signed chain is never trusted.
  const result = await cms.verify(
    {
      signer: 0,
      data: utf8(certificate).buffer,
      checkChain: true,
      trustedCerts: [trusted.at(-1)!],
      passedWhenNotRevValues: true,
      extendedMode: true,
    },
    engine(),
  );
  const signer = result.signerCertificate;
  if (
    !result.signatureVerified ||
    !result.signerCertificateVerified ||
    !signer ||
    hash(new Uint8Array(signer.toSchema().toBER(false))) !== hash(unb64(trust.tsaCertificates[0]))
  )
    throw new Error('Untrusted TSA signature');
  const eku = signer.extensions?.find((e) => e.extnID === '2.5.29.37');
  const purposes = eku
    ? new ExtKeyUsage({ schema: parseASN(eku.extnValue.valueBlock.valueHexView) }).keyPurposes
    : [];
  if (!eku?.critical || purposes.length !== 1 || purposes[0] !== '1.3.6.1.5.5.7.3.8')
    throw new Error('TSA certificate has invalid timestamp usage');
  // RFC 3161 requires the signed ESS certificate binding (SigningCertificateV2).
  const ess = cms.signerInfos[0].signedAttrs?.attributes.filter(
    (a) => a.type === '1.2.840.113549.1.9.16.2.47',
  );
  if (ess?.length !== 1 || ess[0].values.length !== 1)
    throw new Error('Missing TSA certificate binding');
  const seq = ess[0].values[0] as asn1.Sequence;
  const certs = seq.valueBlock.value[0] as asn1.Sequence;
  const certId = certs?.valueBlock.value[0] as asn1.Sequence;
  const fields = certId?.valueBlock.value;
  if (!fields?.length) throw new Error('Invalid TSA certificate binding');
  let certHash = fields[0];
  if (certHash instanceof asn1.Sequence) {
    if (new AlgorithmIdentifier({ schema: certHash }).algorithmId !== '2.16.840.1.101.3.4.2.1')
      throw new Error('Unsupported ESS hash');
    certHash = fields[1];
  }
  if (
    !(certHash instanceof asn1.OctetString) ||
    hex(certHash.valueBlock.valueHexView) !== hash(unb64(trust.tsaCertificates[0]))
  )
    throw new Error('TSA certificate binding mismatch');
  return { time: info.genTime.toISOString(), policy: info.policy };
}

// Log only opaque commitments and a service public key. No media, names, creator IDs or proof IDs.
export const anchorPayload = (certificate: string, timestamp: string) =>
  utf8(`JustTaken external proof v1\n${hash(certificate)}\n${hash(unb64(timestamp))}\n`);
const nodeHash = (left: Uint8Array, right: Uint8Array) =>
  new Uint8Array(sha256(new Uint8Array([1, ...left, ...right])));
export interface Checkpoint {
  origin: string;
  size: number;
  root: string;
  envelope: string;
}
export async function verifyCheckpoint(
  envelope: string,
  trust: AnchorTrust = sigstoreTrust,
): Promise<Checkpoint> {
  if (envelope.length > 8192) throw new Error('Checkpoint too large');
  const split = envelope.indexOf('\n\n');
  const body = envelope.slice(0, split + 1),
    lines = body.split('\n');
  if (
    split < 0 ||
    lines.length !== 4 ||
    !new RegExp(
      '^' + trust.logOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' - [0-9]{1,20}$',
    ).test(lines[0]) ||
    !/^[1-9][0-9]{0,15}$/.test(lines[1])
  )
    throw new Error('Invalid checkpoint');
  const size = Number(lines[1]),
    root = unb64(lines[2]);
  if (!Number.isSafeInteger(size) || root.length !== 32)
    throw new Error('Invalid checkpoint root/size');
  let verified = false;
  for (const line of envelope
    .slice(split + 2)
    .trimEnd()
    .split('\n')) {
    const match = /^— ([^ ]+) ([A-Za-z0-9+/=]+)$/.exec(line);
    if (!match) throw new Error('Malformed checkpoint signature line');
    if (match[1] !== trust.logOrigin) continue;
    const signature = unb64(match[2]);
    if (hex(signature.slice(0, 4)) !== trust.logID.slice(0, 8)) continue;
    await verifyEC(trust.logKey, b64(signature.slice(4)), utf8(body));
    verified = true;
  }
  if (!verified) throw new Error('Untrusted checkpoint signature');
  return { origin: lines[0], size, root: hex(root), envelope };
}
export function verifyInclusion(
  body: Uint8Array,
  index: number,
  checkpoint: Checkpoint,
  hashes: string[],
) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= checkpoint.size || hashes.length > 64)
    throw new Error('Invalid leaf index');
  let fn = BigInt(index),
    sn = BigInt(checkpoint.size - 1),
    root = sha256(new Uint8Array([0, ...body]));
  for (const h of hashes) {
    if (sn === 0n || !/^[a-f0-9]{64}$/.test(h)) throw new Error('Invalid inclusion path');
    const next = unhex(h);
    if ((fn & 1n) === 1n || fn === sn) {
      root = nodeHash(next, root);
      while (fn !== 0n && (fn & 1n) === 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else root = nodeHash(root, next);
    fn >>= 1n;
    sn >>= 1n;
  }
  if (sn !== 0n || hex(root) !== checkpoint.root) throw new Error('Log inclusion mismatch');
}
export function verifyConsistency(older: Checkpoint, newer: Checkpoint, path: string[]) {
  for (const point of [older, newer]) {
    if (!Number.isSafeInteger(point.size) || point.size < 1 || !/^[a-f0-9]{64}$/.test(point.root))
      throw new Error('Invalid checkpoint bounds');
  }
  if (older.origin !== newer.origin || older.size > newer.size || path.length > 64)
    throw new Error('Log rollback or different tree');
  if (older.size === newer.size) {
    if (older.root !== newer.root || path.length) throw new Error('Log fork');
    return;
  }
  let fn = BigInt(older.size - 1),
    sn = BigInt(newer.size - 1);
  while ((fn & 1n) === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  const nodes = path.map((h) => {
    if (!/^[a-f0-9]{64}$/.test(h)) throw new Error('Invalid consistency hash');
    return unhex(h);
  });
  const initial = fn === 0n ? unhex(older.root) : nodes.shift();
  if (!initial) throw new Error('Missing consistency proof');
  let first = initial;
  let second = first;
  for (const node of nodes) {
    if (sn === 0n) throw new Error('Extra consistency node');
    if ((fn & 1n) === 1n || fn === sn) {
      first = nodeHash(node, first);
      second = nodeHash(node, second);
      while (fn !== 0n && (fn & 1n) === 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else second = nodeHash(second, node);
    fn >>= 1n;
    sn >>= 1n;
  }
  if (sn !== 0n || hex(first) !== older.root || hex(second) !== newer.root)
    throw new Error('Log consistency mismatch');
}
export async function verifyLog(
  certificate: string,
  timestamp: string,
  entry: ProofAnchors['log'],
  trust: AnchorTrust = sigstoreTrust,
) {
  if (entry.logID !== trust.logID) throw new Error('Unknown log key');
  const set = JSON.stringify({
    body: entry.body,
    integratedTime: entry.integratedTime,
    logID: entry.logID,
    logIndex: entry.logIndex,
  });
  await verifyEC(trust.logKey, entry.verification.signedEntryTimestamp, utf8(set));
  const proof = entry.verification.inclusionProof,
    checkpoint = await verifyCheckpoint(proof.checkpoint, trust);
  if (checkpoint.root !== proof.rootHash || checkpoint.size !== proof.treeSize)
    throw new Error('Unsigned log root mismatch');
  const bytes = unb64(entry.body);
  verifyInclusion(bytes, proof.logIndex, checkpoint, proof.hashes);
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const payload = anchorPayload(certificate, timestamp);
  if (
    body.kind !== 'hashedrekord' ||
    body.apiVersion !== '0.0.1' ||
    body.spec?.data?.hash?.algorithm !== 'sha256' ||
    body.spec.data.hash.value !== hash(payload)
  )
    throw new Error('Log commitment mismatch');
  const pem = new TextDecoder().decode(unb64(body.spec.signature.publicKey.content));
  if (!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\n?$/.test(pem))
    throw new Error('Invalid log artifact key');
  const key = pem.replace(/-----[A-Z ]+-----|\s/g, '');
  await verifyEC(key, body.spec.signature.content, payload);
  return checkpoint;
}
export async function verifyAnchors(bundle: ProofBundle, trust: AnchorTrust = sigstoreTrust) {
  const anchors = proofAnchorsSchema.parse(bundle.anchors);
  const timestamp = await verifyTimestamp(
    bundle.certificate,
    anchors.timestamp,
    anchors.nonce,
    trust,
  );
  const checkpoint = await verifyLog(bundle.certificate, anchors.timestamp, anchors.log, trust);
  return { timestamp, checkpoint, certificateDigest: hash(bundle.certificate) };
}
export function checkProofPin(previous: string | null, certificate: string) {
  const digest = hash(certificate);
  if (previous !== null && previous !== digest)
    throw new Error('Previously saved proof was replaced');
  return digest;
}
