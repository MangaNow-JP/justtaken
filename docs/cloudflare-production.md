# Cloudflare実環境

2026-10-25、既存Cloudflareアカウント内にJustTaken専用環境を作成した。LP・API・撮影証明ページの正規originは **https://justtaken.app**。独自ドメインのHTTPS応答を確認済み。アプリの一般提供開始はApple/Google登録と実機受入試験の完了後に行う。

## リソース

| 用途                   | 実際の設定                                                                  |
| ---------------------- | --------------------------------------------------------------------------- |
| Worker                 | `justtaken-api` / `ENVIRONMENT=production`                                  |
| 独自ドメイン           | `justtaken.app` / Worker Custom Domain                                      |
| 撮影証明ページ         | https://justtaken.app/verify                                                |
| ヘルスチェック         | https://justtaken.app/health                                                |
| 公開鍵                 | https://justtaken.app/.well-known/capture-jwks.json                         |
| D1 `HOME`              | `justtaken-home-production` / `77408729-6699-4d3b-a5b8-b4f30b16d71c` / APAC |
| R2 `STAGING`           | `justtaken-staging-production` / private                                    |
| R2 `ORIGINALS`         | `justtaken-originals-production` / private                                  |
| SQLite Durable Objects | `AuthSession`、`CaptureSecurity`、JustTaken専用namespace                    |
| 再試行                 | `*/5 * * * *`、外部時刻・監査ログが未完了の証明を最大5件処理                |
| rate limit             | 1 IPあたり120 requests / 60秒、専用namespace `1002`                         |
| 環境定義               | `workers/api/wrangler.production.jsonc`                                     |

元の `workers/api/wrangler.jsonc` はローカル開発用に残す。本番は `workers_dev=false`、preview URL無効。DBは単一home構成であり、4-shard化は未実装。

R2は両方ともr2.dev無効、公開カスタムドメインなし。原本はAPIの所有権・閲覧権限の検査を通して取得する。一時領域のオブジェクトは7日で期限切れにし、未完了multipartは両バケットで2日後に中止する。保存済み原本には自動削除期限を設けない。DO alarmによる期限切れ転送の清掃も継続する。

## 秘密鍵と公開鍵

本番専用の新しいP-256鍵を生成し、`RECEIPT_PRIVATE_JWK`、`RECEIPT_KEY_ID`、`MEDIA_SECRET`をCloudflare Secretsへ登録した。開発鍵の流用はしていない。生成時の一時ファイルは権限0600・親ディレクトリ0700で扱い、公開鍵照合後に削除した。秘密鍵の平文バックアップはリポジトリにない。

初期kid: `production-2026-10-25-3b69850cb591`。受信者用の初期公開鍵は [`workers/api/trust/justtaken-production-jwks.json`](../workers/api/trust/justtaken-production-jwks.json)。運営と独立して保存した公開鍵・検証CLIを使うことで、後日配信ページを差し替えられるリスクを分離する。

`npm run build:proof-cli` は `artifacts/verifier/` に独立検証CLI、本番公開鍵、使い方、SHA256SUMSをまとめる。この一式と受け手の検証履歴を運営以外の保管先に保存する。チェックサム自体を後から差し替えられた場合まで保証するものではない。

通常の再デプロイではCloudflareに保存されたSecretsを保持する。鍵を再生成しない。ローテーションでは、新しいkidと鍵を用意し、旧**公開鍵だけ**を `RECEIPT_PUBLIC_JWKS` に保持する。鍵とkidと公開鍵履歴は同一バージョンへ一緒に反映し、保存した公開鍵ファイルも更新する。漏えい時は `REVOKED_RECEIPT_KEY_IDS` に対象kidを追加する。秘密鍵の取り出しを前提にせず、紛失時は新しい鍵へローテーションする。署名権限の別Workerへの分離と独立した鍵保管は今後の作業。

## 更新手順

```sh
npm run check
npm run test:integration
npm run deploy:production
npm run verify:production
```

`deploy:production` は **リモートD1** へのmigration適用と本番Worker更新を行う。実行前にmigrationの変更内容とCloudflareアカウントを確認する。fixture Workerを指定しない。DBや原本バケットを作り直さない。

設定だけの変更はWorkerのdry-runと関係する型検査で確認できる。APIの動作を変えた場合は上記の単体・結合テストも実施する。

```sh
npx wrangler deploy --config workers/api/wrangler.production.jsonc --dry-run
npx wrangler deployments list --config workers/api/wrangler.production.jsonc
npx wrangler tail justtaken-api --config workers/api/wrangler.production.jsonc
```

Workerのロールバックはコードと設定が対象で、D1 migrationやR2の内容は戻らない。データベース変更には別途復元計画を準備する。既存バージョンの署名鍵・issuerとの整合性も確認する。

## Apple / Google接続時に設定する値

Cloudflare側の器は稼働しているが、Apple/GoogleのJustTaken専用アプリ登録は未設定。このため `/health` は `authentication=false`、`captureVerification=false`、`publication=false` を返す。未設定プロバイダーへのログインは503で停止する。

- Google OAuth redirect URI: `https://justtaken.app/v1/auth/google/callback`
- アプリのAPI: `EXPO_PUBLIC_API_URL=https://justtaken.app`
- iOS: `APP_ATTEST_ENVIRONMENT=production`、JustTaken専用Bundle ID・Team IDが必要。
- Android: JustTaken専用package、Play App Signing証明書、Cloudプロジェクト番号とPlay Integrityサービスアカウントが必要。
- アプリ復帰schemeは現在の実装と同じ `justtaken-dev://auth`。配布用schemeを変更するときはモバイル・Worker双方を更新する。

[`apps/mobile/.env.production.example`](../apps/mobile/.env.production.example) を使い、登録済みのIDを埋めてからネイティブアプリを再ビルドする。既存のローカル開発アプリの接続先は自動で変更していない。OAuth secret・サービスアカウントJSONはWorker Secretsだけに保存する。

```sh
# 準備済みのファイルは0600、JSONは秘密値をログに出さない場所で作成する。
# secret bulk は即時反映し得るため、関連値をまとめて指定する。
npx wrangler secret bulk /absolute/path/to/protected-provider-secrets.json \
  --config workers/api/wrangler.production.jsonc
```

各プロバイダーに必要な項目と実機手順は [アプリ登録・接続](setup-accounts.md) を参照。認証を接続しても、SNS公開には内容審査の運用接続が必要。

## 検証結果と運用の境界

- 独自ドメインでLP・公開API検査28項目成功。HTTPS、公開鍵一致、DBを使う共有検索、CORS、未ログインの拒否、fixture入口の不在、未設定プロバイダーの停止、検証ページとJS配信を確認。
- 両R2で8KiBのランダム検査データを保存・取得し、SHA-256と全バイト一致を確認。検査用オブジェクトは削除済み。
- D1 migration 0001〜0006、Secret 3項目、専用DO・R2・DB binding、cron設定をCloudflareから読み戻して確認。
- 2026-10-25 22:05:36 JST、Cloudflareが起動した `*/5 * * * *` のscheduled処理を観測。`outcome=ok`、例外0件。対象の本番バージョンは `8383641a-7603-4af4-824a-2ec95f23e45e`。未処理の証明が0件の状態での実行確認であり、実機証明の再送試験は接続後に実施する。
- ブラウザーで https://justtaken.app/verify を表示し、console error/warningなし。
- 本番環境に実ユーザー、実撮影証明、検証済みの偽データは作成していない。実機撮影から外部時刻認証・投稿までの一巡はApple/Google接続後に実施する。

証跡はgitignore対象の `artifacts/cloudflare/` に保存。`production-smoke.json`、`storage-verified.json`、`remote-verified.json`、`cron-observed.json`、`final-deploy.log`。画面は `artifacts/justtaken-production-verifier.png`。

Workers Logsと1% samplingのTracesを有効化し、query stringは除外、リクエストごとのinvocation logは無効化した。エラー本文に鍵・原本・認証情報を含めない。課金/障害アラート、外部からの死活監視、復元訓練は未接続。公開サービス開始前に追加する。

参考: [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)。

## LPの公開

2026-10-25、Workers Static Assetsを追加し、ルートにLPを配置。最新公開版は `5bd6e21c-138e-4de0-9b63-53f8d0f00129`。先行登録のD1テーブルと専用rate limit（namespace `1003`、6 requests / 60秒）を追加し、5分cronで180日を過ぎた登録を削除する。既存のAPI・検証ページ・署名鍵・原本バケットは継続利用。[LPの仕様と配信の未接続部分](landing-page.md)を参照。

運営会社（株式会社IMAKAI）の表記と、写真ロゴの表示切り替え体験を反映済み。原本・署名処理は変更していない。[表示設定の範囲](photo-watermark.md)。

`/#biz` に保険の事故・損害確認を中心とする法人向けの活用例を追加。法人専用機能の提供開始ではなく、照合の流れと証明の範囲を紹介するLP更新。公開後の28項目検査に成功（`artifacts/lp-biz/production-smoke.json`）。

## 任意の撮影位置

2026-10-25、GPSを任意で記録するprivate manifestと、所有者限定の `GET /v1/proofs/:id/location` を公開。公開証明・SNS・原本には座標を追加しない。削除／未完了撮影の期限切れ時には現行レコードから座標を除去。[仕様と実機検証の境界](capture-location.md)。署名キー・バケット・DB構成を維持。
