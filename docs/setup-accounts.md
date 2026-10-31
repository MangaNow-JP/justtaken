# JustTaken 新規アプリ登録・接続手順

2026-10-31更新。SNS機能と撮影署名の正規化修正を含むビルド4を作成済みですが、実機への更新とAppleへのアップロードはMacのロック解除・再接続待ちです。`app.justtaken.dev` はローカル開発用です。AppleにはImakai Inc.（Team `CQC25QD69U`）の正式App ID `app.justtaken.ios` を登録し、Sign in with AppleとApp Attestを有効化しました。専用キーチェーンで署名した1.0.0 (3) をApp Store ConnectのJustTaken（`6828439735`）へアップロードし、「提出準備完了」を確認済みです。本番APIのApple接続と暗号化した連携トークンの保管を実装・設定し、本人から実機Appleログイン成功の報告を受けました。撮影証明保存エラーにつながる署名の並び順の不一致を修正し、Swiftとサーバーの一致を検証しました。修正版の実機受入試験と審査提出は未完了です。Cloudflareの本番DB・非公開R2・Workerは `https://justtaken.app` で稼働しています。本番にあったAndroid・認証・成人向け同意・退会・Web設定は回収してソースへ同期済みです。最新の提出条件は [iOS初回申請](app-store/submission.md) を参照してください。

## 設定するもの

| 場所            | 値                                                            | 用途                                      |
| --------------- | ------------------------------------------------------------- | ----------------------------------------- |
| Apple Developer | Team ID、JustTakenのBundle ID                                 | Sign in with Apple / App Attest、実機署名 |
| Google Cloud    | プロジェクトID・番号、Web OAuthクライアントID/secret          | Googleログインのサーバーcallback          |
| Google Play     | JustTakenのpackage、配布versionCode、Play App Signing SHA-256 | Play Integrityの認証と配布条件            |
| Google Cloud    | Play Integrity用サービスアカウントJSON                        | サーバーでのtoken decode                  |
| Cloudflare      | JustTaken専用D1、private R2 2個、Worker HTTPS URL             | アカウント、写真、API                     |

秘密鍵やトークンはチャットに貼らず、ローカルのgitignore対象設定かWorker secretsに保存します。

## 1. Apple

1. DeveloperアカウントでJustTaken用のExplicit App IDを登録し、Sign in with AppleとApp Attestを有効化する。既存アプリのIDを流用しない。
2. モバイル `apps/mobile/.env.local` に `JUSTTAKEN_BUNDLE_ID` と `APPLE_TEAM_ID` を設定。
3. Workerに同じBundle IDを `APPLE_AUDIENCE` と `APPLE_BUNDLE_ID`、Team IDを `APPLE_TEAM_ID` として設定。
4. 開発時は `APP_ATTEST_ENVIRONMENT=development`。本番はモバイル・Workerともproductionに揃える。本番Workerはdevelopment attestationを受け付けない。
5. prebuild / ビルドをやり直し、プロビジョニングしたiPhone実機で検証する。シミュレーターはカメラとApp Attestの受入試験に使用しない。

参照: [Expo AppleAuthentication](https://docs.expo.dev/versions/latest/sdk/apple-authentication/)、[Appleのサーバー検証手順](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)。

## 2. Googleログイン

1. JustTakenのCloudプロジェクト・OAuth同意画面・Webアプリ用OAuthクライアントを作る。テスト段階ではテストユーザーを設定する。
2. Authorized redirect URIは `https://justtaken.app/v1/auth/google/callback`。アプリschemeをGoogleのredirect URIには設定しない。
3. `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` はWorker側だけに設定。要求scopeはopenidのみ。
4. Workerの `API_ORIGIN` をHTTPSのAPI originに、`APP_RETURN_URL` を `justtaken-dev://auth` に設定。現実装はこのschemeをモバイルと共有する。
5. モバイルでSHA-256 PKCE verifierを生成し、Google認可後の一回限りhandoff codeを回収する。server callbackでGoogle tokenの署名とnonceを検証し、handoff交換時にPKCEを検証する。

## 3. Android / Play Integrity

1. JustTaken専用packageでGoogle Playにアプリを登録し、Cloudプロジェクトをリンクする。
2. Play Integrity APIを有効化し、Google Play経由の内部テスト配布を用意する。
3. モバイルに `JUSTTAKEN_ANDROID_PACKAGE` と `GOOGLE_CLOUD_PROJECT_NUMBER` を設定。番号はビルド時のmanifest metadataに含める。
4. Workerに `ANDROID_PACKAGE`、`ANDROID_MIN_VERSION`、`ANDROID_CERTIFICATES`（Play署名証明書のSHA-256をbase64urlにしたもの）、`GOOGLE_SERVICE_ACCOUNT` を設定。
5. `PLAY_RECOGNIZED`、`MEETS_DEVICE_INTEGRITY`、`LICENSED`を必須にしている。認証判定を通すためのローカルdebug bypassは設けていない。

このMacにはJava 11（他アプリ同梱）とAndroid API 28 SDKがあり、動画コードの限定的なコンパイル確認を実施した。Expoアプリ全体のAPKビルドには、対応JDKと現行Android SDKの導入・ライセンス確認が必要。

参照: [Play Integrityセットアップ](https://developer.android.com/google/play/integrity/setup)、[Standard request](https://developer.android.com/google/play/integrity/standard)、[verdictの検証](https://developer.android.com/google/play/integrity/verdicts)。

## 4. Cloudflare実環境

ローカルは `npm run setup:local` と `workers/api/wrangler.jsonc` を使う。本番は別の `workers/api/wrangler.production.jsonc` に分離した。ローカルのプレースホルダーIDをリモートへ置き換えない。

- Worker `justtaken-api` を `https://justtaken.app` へ配置済み。`ENVIRONMENT=production`、workers.devとpreview URLは無効。
- D1 `justtaken-home-production` にmigration 0001〜0005を適用済み。単一home DBで、directory / 4-shard構成への移行は別工程。
- R2 `justtaken-staging-production` / `justtaken-originals-production` は非公開。stagingのみ7日で削除し、両バケットの未完了multipartは2日で中止。原本の自動削除期限は設定しない。
- 新規生成した本番用 `RECEIPT_PRIVATE_JWK`、`RECEIPT_KEY_ID`、`MEDIA_SECRET` をWorker Secretsに登録済み。通常更新で再生成しない。
- 外部時刻・監査ログの再試行cronは5分ごとに実行する。
- OAuth client secret、GoogleサービスアカウントJSONは専用アプリ登録後にWorker Secretsへ追加する。モバイルへ埋め込まない。
- モバイルの本番設定は `apps/mobile/.env.production.example` を使い、`EXPO_PUBLIC_API_URL=https://justtaken.app` と `APP_ATTEST_ENVIRONMENT=production` を設定。正式アプリIDを埋めてネイティブを再ビルドする。

リソースID・デプロイ・公開鍵管理・検証結果は [Cloudflare実環境](cloudflare-production.md) を参照。

参照: [R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[SQLite DO](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。

## 実機の受入手順

1. Apple / Googleでログインし、再起動でログイン情報が安全に復元されること、ログアウト/全端末ログアウトが効くことを確認。
2. 端末登録 → サーバーnonce取得 → 撮影 → native JPEG/HEIF/DNG・manifest・証明 → commitを5分内に完了。
3. アプリを再起動し、下書きから同じ撮影を再送。commitとreceiptと投稿が重複しないことを確認。
4. 写真の撮影出力と保存後の圧縮画素・ICC・向きの一致、GPS削除を確認。動画は前後カメラ・音声/無音・4K対応レンズ・HDR・回転・60秒自動停止を試験し、映像/音声サンプルの一致を確認。thumb/posterは480px/64KiB以下。
5. 8MiBを超える原画で通信断・再起動・期限切れ・取消を試し、受領済みpartを再送せず復帰できることを確認。R2へ原画とプレビューを送信し、検証票とVERIFIEDを確認。投稿は内容確認が終わるまでPROCESSINGで所有者だけが見える。
6. 運営が写真を実際に確認して `moderation_decisions` を記録した後、投稿の「確認状況を更新」で公開条件を再検査。設定内の「運営の確認待ち」から審査できます。利用する担当者のuser IDを本番のMODERATOR_USER_IDSへ明示設定する必要があります。
7. 他アカウント・非承認フォロワー・ブロック・削除済み投稿・古いmedia grant・Range/HEADでもアクセスを拒否することを実機で確認。

`npm run test:integration` は実際のworkerdを使うが、テスト鍵・テストアカウントを隔離されたfixture Workerへ注入する。Apple/Google本物のアカウントや実機センサーの認証が成功した証拠ではない。fixture Workerはデプロイしない。
