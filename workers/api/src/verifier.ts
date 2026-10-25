import { sha256 } from '@noble/hashes/sha256';
import { verifierJS, hashWorkerJS } from './generated/verifier';
// Inline CSS is allowed by its hash, so the page needs no 'unsafe-inline'.
const style = `
:root{color-scheme:light;--ink:#103d34;--muted:#67766c;--lime:#c4ef78;--line:#dce5dc}*{box-sizing:border-box}body{margin:0;background:#f5f6f1;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif;line-height:1.7}main{max-width:780px;margin:auto;padding:40px 24px 70px}header{display:flex;align-items:center;gap:12px;margin-bottom:52px}.mark{border:3px solid var(--ink);border-radius:14px;font-size:16px;font-weight:900;padding:4px 8px;position:relative}.mark:after{content:"";background:var(--lime);border:2px solid #f5f6f1;width:10px;height:10px;border-radius:50%;position:absolute;right:-5px;top:-5px}header strong{font-size:25px;letter-spacing:-1px}header small{margin-left:auto;color:var(--muted)}.eyebrow{font-size:12px;letter-spacing:2px;color:var(--muted)}h1{font-size:clamp(28px,6vw,42px);line-height:1.4;letter-spacing:-1px;margin:12px 0 18px}p{font-size:14px;color:var(--muted)}.intro{max-width:560px;margin-bottom:32px}.card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:24px;margin:16px 0}.step{font-size:12px;letter-spacing:1px;color:var(--muted)}h2{font-size:20px;margin:4px 0 18px}.status{border-radius:12px;background:#f1f4ee;padding:14px 16px;font-size:14px;margin:12px 0;overflow-wrap:anywhere}[data-state=good]{background:#e4f4ca;color:#17472d}[data-state=bad]{background:#fdece9;color:#922e28}[data-state=warn]{background:#fff3d2;color:#775316}input{display:block;width:100%;border:1px dashed #9aad9b;border-radius:12px;padding:14px;margin:12px 0;font-size:14px;color:var(--ink)}input::file-selector-button{border:0;background:var(--lime);border-radius:8px;padding:10px;margin-right:12px;color:var(--ink);cursor:pointer}button{border:0;padding:12px 18px;border-radius:10px;background:var(--lime);font-weight:600;color:var(--ink);cursor:pointer;margin:4px 8px 4px 0}button:disabled,input:disabled{opacity:.45;cursor:default}button.secondary{background:#edf1e7}details{border-top:1px solid var(--line);padding-top:18px;margin-top:18px}summary{cursor:pointer;font-size:14px}dl{font-size:13px;margin:16px 0}dl>div{display:grid;grid-template-columns:1fr 2fr;border-bottom:1px solid #edf0e9;padding:10px 0;gap:12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}progress{width:100%;accent-color:var(--ink);height:8px}.privacy{font-size:12px}footer{padding:20px 0;font-size:12px;color:var(--muted)}[hidden]{display:none!important}:focus-visible{outline:3px solid #6c942e;outline-offset:4px}@media(max-width:480px){main{padding:26px 16px 50px}header{margin-bottom:32px}.card{padding:20px}dl>div{grid-template-columns:1fr}header small{font-size:10px}}`;
const styleHash =
  'sha256-' + Buffer.from(sha256(new TextEncoder().encode(style))).toString('base64');
const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>撮影証明を検証 | JustTaken</title><style>${style}</style></head>
<body><main><header><span class="mark" aria-hidden="true">JT</span><strong>JustTaken</strong><small>撮影証明の検証</small></header>
<div class="eyebrow">CAPTURE PROOF</div><h1>その一枚に、<br>確かめられる撮影記録を。</h1><p class="intro">写真・動画の撮影記録と、受け取ったファイルの一致を確認します。SNSへの投稿も、検証する人のログインも必要ありません。</p>
<section class="card"><span class="step">01 / CERTIFICATE</span><h2>証明の署名を確認</h2><div id="availability" class="status" role="status">証明ファイルからの検証 · 共有リンクの状態は未確認</div><p id="expiry"></p><button id="refresh" class="secondary" hidden>リンクの状態を再確認</button><div id="signature" class="status" role="status">共有リンクを開くか、証明ファイルを選んでください。</div><div id="anchoring" class="status" role="status">第三者の時刻認証・監査ログは未確認です。</div><div id="history" class="status" role="status">この端末に保存した記録との比較は未確認です。</div><label for="certificate">署名付き証明ファイル（.json）</label><input id="certificate" type="file" accept=".json,application/json"><dl id="details" hidden></dl><button id="download" disabled>証明ファイルを保存</button></section>
<section class="card"><span class="step">02 / ORIGINAL FILE</span><h2>受け取った原本を照合</h2><label for="original">写真・動画の元ファイル</label><input id="original" type="file" disabled><progress id="progress" max="1" value="0" hidden aria-label="原本の照合状況"></progress><div id="file-status" class="status" role="status">原本を選ぶと、ファイル全体を照合します。</div><p class="privacy">ファイルはこの端末内で処理されます。写真・動画の内容やファイル名をサーバーへ送信しません。HEIF・RAW・HDRや動画も、表示・変換せずバイト単位で照合します。</p></section>
<section class="card"><h2>この証明で確認できること</h2><p>発行元が記録したアプリでの撮影経路と、ファイルの一致です。アカウントIDは撮影に使ったアカウントを識別します。実名本人確認・著作権・被写体の真実性を証明するものではありません。</p><details><summary>証明の範囲と共有について</summary><p>画面や印刷物の再撮影、演出、端末・アプリや発行元の侵害は残るリスクです。端末の撮影日時は端末時計で、サーバー日時は発行元の記録です。第三者時刻は、その時刻までに証明書が存在したことを示します。撮影日時そのものを保証しません。監査ログには証明のハッシュとサービス公開鍵が残り、原本や撮影者情報は送りません。</p><p>写真を加工・再圧縮したり、送信先アプリで変換すると一致しません。元ファイルの形式を保つ「ファイルとして送信」を利用してください。以前の撮影仕様（capture-v1）は縮小後の保存ファイルを証明します。</p><p>リンクの停止・原本の削除後も、既に保存された証明の署名自体は残ります。証明ファイルだけでは現在の共有可否は分かりません。同じ証明IDの差し替えは、この端末に保持した指紋との比較で検出します。履歴を消した端末や初めて受け取る証明について、以前の版の存在まで保証するものではありません。運営が検証ページ自体を変更するリスクに備え、独立して保管した検証ツールと信頼鍵でも照合してください。</p></details></section><footer>JustTaken · 撮影記録とファイルの整合性を確かめるための証明<br>運営：株式会社IMAKAI<br><a href="/terms">利用規約</a> · <a href="/privacy">プライバシーポリシー</a></footer></main><script src="/verify.js" defer></script></body></html>`;
export function verifierRoutes(request: Request): Response | undefined {
  if (request.method !== 'GET') return;
  const path = new URL(request.url).pathname;
  if (!['/verify', '/verify.js', '/verify-hash.js'].includes(path)) return;
  return new Response(
    path === '/verify' ? page : path === '/verify.js' ? verifierJS : hashWorkerJS,
    {
      headers: {
        'Content-Type':
          path === '/verify' ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src '${styleHash}'; connect-src 'self' https://rekor.sigstore.dev; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types justtaken-verify`,
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    },
  );
}
