import './zod-jitless';
import { verifyProof, type ProofTrust } from '../src/proof-verify';
import { proofBundleSchema, type ProofBundle, type CaptureProof } from '@justtaken/contracts/proof';
import {
  checkProofPin,
  hash,
  verifyAnchors,
  verifyCheckpoint,
  type Checkpoint,
} from '../src/anchor-crypto';
import { AnchorNetworkError, checkLiveLog, checkConsistency } from '../src/anchor-client';
// The page enforces Trusted Types; the hashing worker is the only script URL it creates.
type ScriptURLPolicy = { createScriptURL(url: string): unknown };
const scriptPolicy = (
  globalThis as {
    trustedTypes?: {
      createPolicy(name: string, rules: { createScriptURL(url: string): string }): ScriptURLPolicy;
    };
  }
).trustedTypes?.createPolicy('justtaken-verify', {
  createScriptURL(url) {
    if (url !== '/verify-hash.js') throw new TypeError('Unexpected script URL');
    return url;
  },
});
const hashWorkerURL = () =>
  (scriptPolicy?.createScriptURL('/verify-hash.js') ?? '/verify-hash.js') as string;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (id: string, text: string, state = '') => {
  $(id).textContent = text;
  $(id).dataset.state = state;
};
let proof: CaptureProof | undefined, bundle: ProofBundle | undefined, worker: Worker | undefined;
let revision = 0;
const capability = /^#([A-Za-z0-9_-]{36})\.([A-Za-z0-9_-]{43})$/.exec(location.hash);
// Fragment secrets never enter HTTP paths, Referer, server logs or analytics.
if (location.hash) history.replaceState(null, '', '/verify');
async function retainHistory(
  pinKey: string,
  certificate: string,
  generation: number,
  current?: Checkpoint,
) {
  // Serialize cross-tab first observation and checkpoint updates. Without Web Locks,
  // retain no new history rather than claiming race-safe replacement detection.
  if (!navigator.locks) return false;
  try {
    return await navigator.locks.request('justtaken-proof-history', async () => {
      if (generation !== revision) return false;
      checkProofPin(localStorage.getItem(pinKey), certificate);
      let checkpoint = current;
      const checkpointKey = current
        ? 'justtaken.log-checkpoint.' + hash(current.origin)
        : undefined;
      const saved = checkpointKey ? localStorage.getItem(checkpointKey) : null;
      if (saved && current) {
        const latest = await verifyCheckpoint(saved);
        if (latest.size > current.size) {
          await checkConsistency(current, latest);
          checkpoint = latest;
        } else await checkConsistency(latest, current);
      }
      if (generation !== revision) return false;
      localStorage.setItem(pinKey, hash(certificate));
      if (checkpointKey && checkpoint) localStorage.setItem(checkpointKey, checkpoint.envelope);
      return true;
    });
  } catch (e) {
    if (e instanceof DOMException && ['SecurityError', 'QuotaExceededError'].includes(e.name))
      return false;
    throw e;
  }
}
async function json(response: Response) {
  if (!response.ok)
    throw new Error('共有リンクが無効、期限切れ、停止中、または証明が利用できません。');
  const text = await response.text();
  if (text.length > 131072) throw new Error('証明データが大きすぎます。');
  return JSON.parse(text);
}
async function checkLink() {
  if (!capability) return;
  const data = await json(
    await fetch('/public/proof-shares/' + capability[1], {
      method: 'POST',
      headers: { 'X-Proof-Token': capability[2] },
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      credentials: 'omit',
      redirect: 'error',
    }),
  );
  return data;
}
function reset() {
  revision++;
  proof = undefined;
  bundle = undefined;
  worker?.terminate();
  $('details').hidden = true;
  $<HTMLInputElement>('original').disabled = true;
  $<HTMLButtonElement>('download').disabled = true;
  $<HTMLInputElement>('original').value = '';
  status('file-status', '原本を選ぶと、ファイル全体を照合します。');
  status('signature', '署名を確認中…');
  status('anchoring', '第三者の時刻認証・監査ログは未確認です。');
  status('history', 'この端末に保存した記録との比較は未確認です。');
  $('progress').hidden = true;
}
async function load(value: unknown) {
  reset();
  const generation = revision;
  try {
    const candidate = proofBundleSchema.parse(value);
    const trust = (await json(
      await fetch('/.well-known/capture-jwks.json', {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
        credentials: 'omit',
        redirect: 'error',
      }),
    )) as ProofTrust;
    const verified = await verifyProof(candidate, location.origin, trust);
    const pinKey = 'justtaken.proof-pin.' + hash(verified.issuer + '/' + verified.proofId);
    let storage = true;
    let previous: string | null = null;
    try {
      previous = localStorage.getItem(pinKey);
    } catch {
      storage = false;
    }
    checkProofPin(previous, candidate.certificate);
    if (candidate.anchors) {
      const anchored = await verifyAnchors(candidate);
      if (generation !== revision) return;
      status(
        'anchoring',
        '第三者時刻：' +
          new Date(anchored.timestamp.time).toLocaleString() +
          ' までに証明書が存在。Sigstoreの時刻署名とRekorへの収録を検証しました。',
        'good',
      );
      const checkpointKey = 'justtaken.log-checkpoint.' + hash(anchored.checkpoint.origin);
      let previousCheckpoint: string | undefined;
      try {
        previousCheckpoint = localStorage.getItem(checkpointKey) ?? undefined;
      } catch {
        storage = false;
      }
      try {
        const current = await checkLiveLog(anchored.checkpoint, previousCheckpoint);
        if (generation !== revision) return;
        storage = await retainHistory(pinKey, candidate.certificate, generation, current);
        if (generation !== revision) return;
        status(
          'history',
          storage
            ? '公開ログへ直接照会し、収録時から現在までの履歴の連続性を確認しました。証明の指紋をこの端末に保存しました。'
            : '公開ログの連続性は確認済み。このブラウザには履歴を保存できないため、証明ファイルを保存してください。',
          storage ? 'good' : 'warn',
        );
      } catch (e) {
        if (generation !== revision) return;
        if (!(e instanceof AnchorNetworkError)) throw e;
        status(
          'history',
          '第三者の署名と収録証明は有効ですが、現在の公開ログへ接続できず、最新の連続性は未確認です。',
          'warn',
        );
        if (storage) await retainHistory(pinKey, candidate.certificate, generation);
      }
    } else {
      if (generation !== revision) return;
      status(
        'anchoring',
        verified.anchorPolicy
          ? '第三者証明が未完了、または取り除かれています。運営の署名だけでは独立した改ざん検出を確認できません。'
          : '従来形式：第三者時刻認証・監査ログの証拠が付いていません。',
        'warn',
      );
    }
    if (generation !== revision) return;
    proof = verified;
    bundle = candidate;
    const production =
      proof.evidence.deviceEnvironment === 'production' &&
      proof.evidence.serviceEnvironment === 'production';
    status(
      'signature',
      production
        ? '署名を検証しました'
        : '開発・テスト用の署名です。本番の撮影証明ではありません。',
      production ? 'good' : 'warn',
    );
    const rows = [
      ['発行元', proof.issuer],
      ['証明ID', proof.proofId],
      ['撮影アカウントID', proof.creatorId],
      ['端末の撮影日時（端末時計）', new Date(proof.deviceCapturedAt).toLocaleString()],
      ['サーバー受付日時', new Date(proof.serverCommittedAt).toLocaleString()],
      ['サーバー照合日時', new Date(proof.serverVerifiedAt).toLocaleString()],
      ['ファイル', `${proof.original.mime} · ${(proof.original.bytes / 1048576).toFixed(2)} MiB`],
      [
        '記録仕様',
        `${proof.policyVersion} · ${proof.original.width} × ${proof.original.height}${proof.original.hasGainMap ? ' · HDRゲインマップ' : ''}${proof.original.durationMs ? ' · ' + (proof.original.durationMs / 1000).toFixed(1) + '秒' : ''}`,
      ],
      ['SHA-256', proof.original.sha256],
    ];
    $('details').replaceChildren(
      ...rows.map(([label, value]) => {
        const row = document.createElement('div'),
          dt = document.createElement('dt'),
          dd = document.createElement('dd');
        dt.textContent = label;
        dd.textContent = value;
        row.append(dt, dd);
        return row;
      }),
    );
    $('details').hidden = false;
    $<HTMLInputElement>('original').disabled = false;
    $<HTMLButtonElement>('download').disabled = false;
  } catch (e) {
    if (generation !== revision) return;
    status(
      'signature',
      e instanceof Error && e.message === 'Previously saved proof was replaced'
        ? '以前に保存した同じ証明IDの内容と異なります。証明の差し替えを検出しました。'
        : '証明を検証できません。署名・第三者証拠・過去の記録との不一致、または接続の問題があります。',
      'bad',
    );
  }
}
$('certificate').addEventListener('change', async () => {
  const file = $<HTMLInputElement>('certificate').files?.[0];
  if (!file) return;
  reset();
  const generation = revision;
  // A separately imported certificate has no online status capability, even on a share page.
  status('availability', '証明ファイルからの検証 · 共有リンク・原本の現在の状態は未確認', 'warn');
  $('expiry').textContent = '';
  try {
    if (file.size > 131072) throw new Error();
    const candidate = JSON.parse(await file.text());
    if (generation === revision) await load(candidate);
  } catch {
    if (generation === revision) {
      reset();
      status('signature', '証明ファイルを読み込めません。', 'bad');
    }
  }
});
$('original').addEventListener('change', () => {
  const file = $<HTMLInputElement>('original').files?.[0],
    expected = proof;
  if (!file || !expected) return;
  worker?.terminate();
  if (file.size !== expected.original.bytes) {
    status('file-status', '不一致：ファイルのサイズが撮影証明と異なります。', 'bad');
    $('progress').hidden = true;
    return;
  }
  status('file-status', '端末内で原本を照合中…');
  const bar = $<HTMLProgressElement>('progress');
  bar.hidden = false;
  bar.value = 0;
  worker = new Worker(hashWorkerURL());
  const task = worker;
  worker.onmessage = ({ data }) => {
    if (worker !== task || proof !== expected) return;
    if (data.progress !== undefined) bar.value = data.progress;
    if (data.error) {
      status('file-status', data.error, 'bad');
      bar.hidden = true;
      worker?.terminate();
    }
    if (data.sha256) {
      const same =
        data.sha256 === expected.original.sha256 && data.bytes === expected.original.bytes;
      const production =
        expected.evidence.deviceEnvironment === 'production' &&
        expected.evidence.serviceEnvironment === 'production';
      status(
        'file-status',
        same
          ? production
            ? '一致：このファイルは撮影証明の原本と同一です。'
            : '一致：開発・テスト証明のファイルと同一です。'
          : '不一致：別のファイル、または変更されたファイルです。',
        same ? (production ? 'good' : 'warn') : 'bad',
      );
      worker?.terminate();
    }
  };
  worker.onerror = () => {
    if (worker !== task || proof !== expected) return;
    status('file-status', '照合を中断しました。ファイルを選び直してください。', 'bad');
    bar.hidden = true;
    worker?.terminate();
  };
  worker.postMessage({ file });
});
$('download').addEventListener('click', () => {
  if (!bundle || !proof) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'JustTaken-' + proof.proofId + '.justtaken-proof.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function loadLink() {
  if (!capability) return;
  reset();
  const generation = revision;
  status('availability', '共有リンクを確認中…');
  try {
    const data = await checkLink();
    if (generation !== revision) return;
    status(
      'availability',
      'リンク有効 · ' + new Date(data.checkedAt).toLocaleString() + ' 時点',
      'good',
    );
    $('expiry').textContent = '共有期限：' + new Date(data.expiresAt).toLocaleString();
    await load(data.bundle);
  } catch {
    if (generation !== revision) return;
    reset();
    status('signature', '共有リンクからの検証を停止しました。', 'warn');
    status('availability', '共有停止・期限切れ・証明の無効化、または接続できません。', 'bad');
  }
}
$('refresh').addEventListener('click', () => void loadLink());
if (capability) {
  $('refresh').hidden = false;
  void loadLink();
}
