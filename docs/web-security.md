# Web配信のセキュリティとキャッシュ

https://justtaken.app/ のLP・規約ページ（静的ファイル）と、同じドメインのWorker応答（`/v1/*`、`/public/*`、`/verify`、`/health`、`/.well-known/*`）に付けるヘッダーの方針。撮影認証・署名・原本の扱いは変えていない。

## 静的ページ（`workers/api/public/_headers`）

| ヘッダー                       | 値                                                                                     | 目的                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Content-Security-Policy`      | `default-src 'none'` を基本に、スクリプト・CSS・フォント・画像・通信を自ドメインに限定 | 外部スクリプトの混入・データ持ち出しを防ぐ           |
|                                | `require-trusted-types-for 'script'; trusted-types 'none'`                             | `innerHTML` 等の文字列からのDOM生成を禁止（DOM XSS） |
| `Strict-Transport-Security`    | `max-age=63072000; includeSubDomains`                                                  | HTTPS固定。`.app` はTLD全体がHSTS preload済み        |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                                                          | 他サイトのウィンドウからの参照を切る                 |
| `Cross-Origin-Resource-Policy` | `same-origin`（共有用 `og-cover.png` のみ `cross-origin`）                             | 他サイトへの埋め込み・読み取りを防ぐ                 |
| `X-Frame-Options`              | `DENY`                                                                                 | 古いブラウザでのクリックジャッキング対策             |
| `Permissions-Policy`           | カメラ・マイク・位置・決済・USB等をすべて無効                                          | LPが使わない端末機能を閉じる                         |
| `Referrer-Policy`              | `no-referrer`                                                                          | 取り消しリンク等のURLを外部へ送らない                |

### キャッシュ

| 対象                                  | `Cache-Control`                       |
| ------------------------------------- | ------------------------------------- |
| HTML・`robots.txt`・`sitemap.xml`     | `public, max-age=0, must-revalidate`  |
| `?v=` 付きで読み込むCSS・JS・フォント | `public, max-age=31536000, immutable` |
| 画像など、その他の `/assets/*`        | `public, max-age=604800`              |

`_headers` は同じ名前のヘッダーをカンマで連結する。2026-10-25までは `/assets/*` が `public, max-age=0, must-revalidate, public, max-age=86400` という矛盾した値になり、実質キャッシュされていなかった。現在は `! Cache-Control` で全体の値を外してから設定している。

**CSS・JS・フォントを変更したら、それを読み込むすべてのHTMLの `?v=` を必ず上げる。** 1年間キャッシュされるため、上げ忘れると古いファイルが表示され続ける。現在はsite.css v8、site.js v4、legal.css v2、landing-jp.woff2 v8。

## Worker応答（`workers/api/src/security-headers.ts`）

Cloudflareは `_headers` をWorkerの応答に適用しないため、`handleRequest` の最後に共通処理で付ける。

- すべての応答：HSTS（HTTPSのときのみ）、`nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。CORSの事前確認（OPTIONS）の拒否応答も含む。
- JSON・テキスト・本文なしの応答：`default-src 'none'` のCSPと `Cross-Origin-Resource-Policy: same-origin`。CORSの許可先（`ALLOWED_ORIGINS`）からのfetchには影響しない。
- 写真・動画・原本の配信：既存の `no-store`・`nosniff` を維持。表示を妨げないよう、CSPとCORPは付けない。
- `/verify`：インラインCSSを `'unsafe-inline'` ではなくSHA-256ハッシュで許可（CSSを変えるとハッシュも自動で再計算）。Trusted Typesを有効にし、`justtaken-verify` ポリシーで作れるスクリプトURLは `/verify-hash.js` だけ。zodが起動時に行う `eval` 可否の検査は `web/zod-jitless.ts` で止めている（従来もCSPで遮断され、コンソールエラーになっていた）。

## 先行登録API

- メールアドレスは、ブラウザの `type=email` と同じ文法で、ドメインにドットを含むものだけを受け付ける。二重引用符・カンマ・セミコロン・空白・制御文字・非ASCIIは拒否し、将来メールを送る際に宛先の追加などへ悪用される値を保存しない。
- LPからの送信は `same-origin`・Cookieなし・キャッシュなし・20秒で打ち切り。Cloudflare等のエラーページ（JSONでない応答）でも英語の解析エラーを表示せず、日本語の案内を出す。
- 正規originの確認、4KiBの本文上限、1 IPあたり6 requests / 60秒、honeypot、重複時も同じ応答形式、取り消しトークンのハッシュ保存は従来どおり。
- ページ下部のメール欄は、登録フォームへアドレスを引き継ぐだけで、それ自体は送信しない（`method="dialog"`、`name` 属性なし）。JavaScriptが動かなくてもURLにメールアドレスが残らない。

## security.txt

`/.well-known/security.txt`（RFC 9116）を公開。連絡先は `info@imakai.co.jp` と公式お問い合わせフォーム。期限（`Expires`）は2027-10-24。期限の30日前から `npm run verify:production` が失敗するので、`SECURITY_TXT_EXPIRES` を1年先に更新して再デプロイする。脆弱性報告専用の窓口や受付方針を設けた場合は、`Contact` と `Policy` を追加する。

## 変更するときの約束

- LPのJavaScriptで `innerHTML`・`insertAdjacentHTML`・`document.write`・`eval`・文字列の `setTimeout` を使わない（Trusted Typesで例外になる）。`textContent` とDOM APIを使う。
- インラインの `<script>`・`<style>`・`style` 属性・`on*` 属性は使えない。構造化データ（`application/ld+json`）は実行されないため利用できる。
- 外部の画像・フォント・スクリプト・解析タグを追加する場合は、CSPの変更に加えてプライバシーポリシーの記載を確認する。

## 依存パッケージの監査（2026-10-25）

`npm audit` はhigh 5件。すべてExpo CLI（`@expo/cli`）経由のビルド用ツールに含まれる `node-forge` と `zod` 3.25で、Workerと公開ページで実行されるコードには含まれない。`node-forge` には修正版がなく、自動修正はexpo@54へのダウングレード（破壊的変更）になるため適用していない。Expoの更新時に再確認する。Worker（jose、cbor、pkijs等）に既知の脆弱性はない。

## 未対応

- ボット対策のCloudflare Turnstile：サイトキーとシークレットの発行が必要。現在はhoneypotとIP単位の制限で運用。
- 依存パッケージ更新の自動化（Dependabot等）。

## 検証

- 型検査と単体96件（ヘッダー、`/verify` のハッシュとTrusted Types、security.txt、メールアドレスの受付・拒否を追加）。
- 実workerd・D1・R2・SQLite DOの結合テスト532 assertions。
- ローカルの `wrangler dev` で静的ファイルとWorker応答のヘッダーを確認。`verify:production` の検査をローカルに向け、HTTPSでのみ付くHSTS・CORS許可先・本番鍵以外はすべて成功。
- ブラウザ：LPでCSP・Trusted Typesの違反なし、`innerHTML` が遮断されることを確認。`/verify` で開発用証明と原本の一致・不一致を照合し、違反とコンソールエラーなし。
