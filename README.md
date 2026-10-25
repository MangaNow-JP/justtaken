# JustTaken

いま撮った、その瞬間を。

運営：株式会社IMAKAI。

React Native / ExpoによるiOS・Androidアプリ。現在は**ログイン → 写真・60秒動画の撮影 → 撮影認証 → アップロード → 撮影証明の保存・共有／投稿・再生**のコードとローカル検証を実装し、Cloudflare実環境を構築済みです。Apple/Google登録・両OS実機試験・アプリの一般提供はまだ完了していません。

本番の[LP](https://justtaken.app/)（先行登録受付付き）、[撮影証明ページ](https://justtaken.app/verify)と[APIヘルスチェック](https://justtaken.app/health)を公開済み。専用DB・非公開R2・本番署名鍵・外部認証再試行cronの設定と更新手順は [Cloudflare実環境](docs/cloudflare-production.md) を参照してください。

[LPの構成・先行登録の運用](docs/landing-page.md)も参照してください。

## 起動

```sh
npm ci
npm run setup:local  # ローカル署名鍵作成（既存ファイルは保持）とD1 migration
npm run api         # http://localhost:8787
npm run dev         # 別ターミナル、http://localhost:8081
```

Node.js 22.13以上。Webは画面確認用で、ログインと撮影は専用のネイティブアプリを使用します。Expo Goは利用できません。

```sh
npm run ios --workspace @justtaken/mobile -- --device
npm run android --workspace @justtaken/mobile
npm run check             # 型チェックと単体テスト
npm run test:integration  # 実際のworkerd・SQLite DO・D1・R2を使うローカル結合テスト
npm run build:web
npm run build --workspace @justtaken/api  # dry-run。デプロイしない
```

## 実装した撮影・投稿フロー

- Apple IDトークンの署名・issuer・audience・nonce検証。Googleはブラウザー認可 → サーバーのcode交換 → nonce検証 → PKCEで保護したアプリ復帰。メールアドレスによるアカウント統合は行わない。
- 15分のアクセストークン、30日の端末別リフレッシュトークン、ローテーション・再利用検出・端末/全端末ログアウト。端末はSecureStore、サーバーはハッシュのみ保存。
- サーバーのnonceをシャッター前にネイティブ撮影へ束縛。原本の画素・圧縮映像・音声を保持し、表示用JPEGだけを別に生成して、native所有のファイルからmanifestとApp Attest assertion / Play Integrity requestHashを作成。
- installation単位のSQLite Durable Objectによるnonce・counter・再送の原子的管理。撮影確定は5分、アップロードは24時間。
- 開発版の共有2 GiB保存枠の原子的予約、非公開R2 stagingへのchecksum付き書込、全ファイルSHA-256検査とimmutable原本保存。新規写真はJPEG/HEIF/DNGの原本全体とHDRゲインマップを保持し、不変オブジェクトの構造・寸法・メタデータを検査。
- ES256の検証票、投稿保存、内容確認待ち、公開条件の再検査、フィード、所有者の削除、投稿の現在の閲覧権限を確認する120秒media grant。非公開アカウントを初期値にする。
- ログイン画面、撮影準備、投稿進捗、通信エラーと下書き再送、投稿一覧・撮影記録・削除UI。
- 前後カメラでの連続動画、音声収録（マイク拒否時は無音）、残り時間・停止・保存、同じ動画から生成したポスター、音声トラックを含む撮影記録の照合。最大60秒・4K対応・512 MiB。録画後の縮小/再エンコードは行わない。
- 動画はタップ再生・初期ミュート。フィードでは同時に1本、スクロール・バックグラウンド移行で停止。Range/HEAD・ETag・416に対応。

原画保持・最大60秒はユーザーの追加指定です。8 MiB単位の再開可能な送信と原画表示を実装。対応形式・制限と検証範囲は[HEIF・RAW・HDR写真](docs/photo-originals.md)と[動画撮影](docs/video-capture.md)を参照してください。

サンプルフィードのいいね・保存・コメントは従来どおり端末内の表示例です。実際のアカウントではサーバーフィードへ切り替わります。

写真の表示には、設定で外せるJustTakenロゴを追加しています。原本と証明は変更せず、書き出す原本はロゴなしです。[表示設定の仕様](docs/photo-watermark.md)。

## SNSから独立した撮影証明

撮影後に「投稿せずに撮影証明を保存」を選ぶと、原本を非公開で保持し、SNSなしで署名付き証明を発行します。証明の期限付き共有・停止、元形式の原本／証明ファイルの書き出し、受け手の端末内での改ざん照合を実装しました。第三者時刻認証（RFC 3161）・Rekor公開監査ログ・受け手の履歴比較も実装し、外部実サービスで合成証明を検証済みです。[外部証明の設計・運用・限界](docs/external-anchors.md)を参照してください。検証画面はAPIの /verify。SNS投稿だけを削除しても、保存済みの証明と原本は残ります。

保証するのは撮影経路とファイル整合性の範囲で、実名本人確認や被写体の真実性ではありません。[使い方・脅威モデル・鍵運用](docs/capture-proof.md)を参照してください。

## 新規アプリの接続

**Cloudflare実環境は稼働済みですが、JustTaken専用のApple/Google登録は未設定です。** 別アプリの識別子・データベース・秘密鍵は転用していません。

[アプリ登録と接続手順](docs/setup-accounts.md) に、設定する値・接続順・実機試験をまとめています。ローカルの設定テンプレートは `apps/mobile/.env.example` と `workers/api/.dev.vars.example`、本番アプリ用は `apps/mobile/.env.production.example` です。実機アップロードの接続先はHTTPS必須です。

## 構成

| 場所                 | 内容                                                                 |
| -------------------- | -------------------------------------------------------------------- |
| `apps/mobile`        | UI、認証、セッション保存、投稿の再送                                 |
| `native/capture`     | Swift / AVFoundation / App Attest、Kotlin / CameraX / Play Integrity |
| `packages/contracts` | 撮影ポリシー、manifest、正規化、公開・閲覧ルール                     |
| `workers/api/src`    | AuthSession / CaptureSecurity DO、R2検証、投稿・media API            |
| `workers/api/test`   | 単体テストと隔離されたテスト専用Worker                               |
| `docs`               | 仕様書、接続手順、API契約、開発状況                                  |

生成される `apps/mobile/ios` と `apps/mobile/android` は管理対象外です。正本は `native/capture` と `apps/mobile/app.config.js` です。

## 残っていること

実プロバイダーでのログイン・端末認証、Androidアプリ全体のビルド/実機確認、OSバックグラウンド転送、フォロー・コメント等の実SNS機能、運営用審査画面、本番の署名サービス分離・鍵運用・D1複数シャード化は未完了です。写真・動画の内容確認は現在 `moderation_decisions` による運営判断が必要で、自動的に許可しません。

詳しい実装範囲・テスト結果・本番前の課題は [開発状況](docs/development-status.md) を参照してください。サンプル素材は [素材一覧](docs/assets.md) に記載しています。
