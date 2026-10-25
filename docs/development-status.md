# 開発状況 — 2026-10-25 / 第三者時刻・公開監査ログ付き撮影証明

## 実装・検証

| 項目             | 状況                                                                                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ログイン画面     | Apple / Google導線、接続状態、未設定時の案内。WebとiOS Simulatorで確認                                                                                                                                      |
| 認証             | OIDC署名/issuer/audience/nonce、Googleサーバーcode交換とPKCE handoff、SecureStore、15分access / 30日refresh、rotation/reuse検出、全端末logoutを実装                                                         |
| native撮影認証   | シャッター前nonce束縛、native manifest、iOS App Attest登録/assertion、Android Standard Integrity requestHashを実装。実サービス/実機の検証は未実施                                                           |
| サーバー撮影認証 | Apple attestation chain/app/key/challenge/環境、assertion署名/counter、Google decode/verdict照合を実装。Apple chainはnode-app-attest 1.0.1に有効期限/CA/CBOR制約を追加                                      |
| セッション管理   | SQLite DOでinstallationごとにnonce/counter/再送/期限を管理。外部await後に同期transactionで再確認                                                                                                            |
| 画像検証・保存   | private R2へSHA-256条件付きPUT。v3はJPEG/HEIF/DNG原本全体を保持し、不変オブジェクトの構造・向き・HDR・RAW・GPSを検査。JPEG/HEIF128MiB、DNG512MiB、2GiB開発枠                                                |
| 動画             | 前後カメラ・音声/無音・60秒/最大4K/512MiB、パススルー、音声の再圧縮なし・ポスター・撮影認証・投稿・タップ再生。MP4の構造、codec、8/10-bit/SDR/HLG/PQ、向き、寸法、時間、音声、offset、hashを照合            |
| GPS設定          | 初期OFF、設定でON/OFF保存、撮影画面の前景だけで測位。写真・動画の開始位置をprivate manifestへ署名。本人限定の確認・座標の非公開化を実装。実機測位は未確認。詳細は[撮影位置](capture-location.md) |
| 検証票           | ES256 JWS。payload・確認日時を先に固定し、再送では保存済みreceiptを返す。公開JWK endpointあり                                                                                                               |
| 投稿             | caption/公開範囲、同一capture一投稿、内容確認待ち、条件付き公開、フィード、閲覧ACL、media grant/Range/HEAD、削除・再公開拒否                                                                                |
| モバイル投稿     | 撮影後commit、送信進捗、下書き再送、投稿一覧、撮影記録、削除、アカウント別下書き                                                                                                                            |
| iOSビルド        | HEIF/RAW/ProRAW撮影・HDR表示・動画を含むXcode / iOS 26.5 Simulator Debugビルド成功。センサーとApp Attestは実機試験が必要                                                                                    |
| 写真形式検証     | ImageIOのHEIF/HDR JPEG（4032×3024含む）、合成Bayer/Linear DNGのデコードを確認。旧v2のJPEG画素/ICC保持試験も維持                                                                                             |
| Android          | CameraX 1.6.2とAndroid API jarでHEIF Camera2・RAW/Ultra HDR CameraX・保存コードをKotlin 2.2.0でコンパイル。Expoの橋渡し部分はcompile-only stub。APK全体と実機は未確認。faststartはJVM実行とserver検査に成功 |
| 単体テスト       | manifest/期限/ACL/重複JSON/Identity claims/Integrity verdict/JPEG/Range/MP4/音声/60秒境界等89件                                                                                                             |
| 結合テスト       | 実workerd・SQLite DO・D1・R2で532 assertions成功。HEIF/RAW/HDR写真・9MiB RAW分割送信・原寸JPEG・4K HEVC/HDR・音声あり/無音の署名、分割送信/再開/取消/期限、検証票、投稿、原本のバイト一致、Range/ACLを検査  |
| 外部環境         | Cloudflareに専用D1・非公開R2 2個・SQLite DO・本番鍵・再試行cronを配置。https://justtaken.app でLPと公開API検査28項目とR2バイト一致を確認。Apple/Googleアプリ登録は未設定                                    |

## 独立した撮影証明

SNSへの投稿なしで保存・署名・共有・失効。原本とJSON証明の書き出し、Web Workerによる受け手端末内の照合、独立した鍵ファイルでのオフライン検証を追加。SNS投稿削除は証明を残し、原本の削除は証明一覧から行う。ブラウザーで原本一致・1バイト変更・署名改ざんを確認。iOS Simulatorを再ビルド・起動済み。詳細は[撮影証明](capture-proof.md)。

第三者RFC 3161時刻認証、Rekor公開監査ログ、収録／整合性検証、受信者指紋・checkpoint保存、独立CLI、保留／再試行を実装。実第三者サービスへの合成commitment登録とブラウザ・CLI検証を完了。Cloudflareに本番デプロイと5分cronを登録済み。[詳細と限界](external-anchors.md)、[実環境の構成・検証・更新](cloudflare-production.md)。

## 結合テストの境界

`workers/api/test/fixture-worker.ts` はテスト専用の入口で、テストアカウント・テスト公開鍵をSQLite DOへ注入する。capture commit自体は実EC署名検証を通し、R2の実ストリーム/checksum、ES256 receipt、D1 transactionをローカルで動かす。

本番入口 `workers/api/src/index.ts` はfixtureをimportしない。HTTP経由の認証回避や検証済みデモデータはない。本物のApple/Google OAuth、Apple証明書発行、Play Integrity端末判定、カメラセンサー出力の試験には、専用アプリ登録と両OS実機が必要。

## 本番前に残る実装

- 実機撮影と認証の一巡、Androidビルド、画質/回転/再起動/通信断/期限切れ/OSバックグラウンド転送の確認。
- JPEG/HEIF/RAWの全画素・動画の全フレーム・音声デコードと内容審査の運用接続。現状のserver inspectorは構造検証で、審査はPENDINGのまま保持し、自動許可しない。
- 検証票署名を専用Worker/権限へ分離。現状はVERIFIEDの撮影記録からreceipt／公開用証明を同一Workerのsecretで署名する。公開鍵履歴・kidローテーション・失効リストは実装済み。独立した鍵保管・監査と運用を追加する。
- Google Standard tokenのdecode後にDO確定前クラッシュするケースの再試行と、App Attest再登録・鍵破損時の導線を実機で検証。
- ネイティブアップロードはforegroundのURLSession / HttpsURLConnection。OS background serviceは未実装。再起動後は下書きから手動再送。
- D1 homeを4物理shardへ分割し、directory/bucket routing・移行・outbox配送を実装。現状は各環境の単一home DBとDO内projection retry。
- 認証challenge・小さい捕捉記録・削除tombstoneの長期保持/GC、未参照R2オブジェクトの定期回収、運用監視・バックアップ/復元を追加。
- フォロー操作、実コメント/いいね、通報/ブロック管理画面、プッシュ通知、アカウント削除、規約・ストア申請。

既存サンプルUIのコメント/いいね/保存は端末内の表示例。ユーザーの実投稿とサンプルを混ぜず、ログイン後はサーバーフィードへ切り替える。

## 環境

Expo 58.0.19 / RN 0.88.0 / React 19.3.0 / TS 6.0.3 / Wrangler 4.152.0。iOS 18、Android API 31以上を設定。CocoaPodsは一時的に `/private/tmp/justtaken-gems` を利用。継続開発用のRuby/JDK/SDK環境は別途整える。

再現コマンド・設定値は [README](../README.md) と [接続手順](setup-accounts.md)。ログと画面証跡はgitignore対象の `artifacts/` に置く。

原画保持の詳細は[写真・動画](video-capture.md)。実AVFoundation出力の圧縮映像/音声を処理前後で比較し、サンプル数・SHA-256一致を確認。61秒入力は切り詰めず拒否。HEIF/RAW/ProRAW・HDRゲインマップのコードは追加済み。標準カメラ独自モードとの同一性、実機のセンサー出力・HDR表示は未検証。[写真原本](photo-originals.md)に範囲を記載。実カメラ・実マイクでの成功を意味しない。`original-check.log`、`original-integration.log`、`original-video-fixtures.log`、`original-photo-fixtures.log`、`ios-build-original.log`、`kotlin-original-compile.log`を保存。

## 依存関係の監査

最終 `npm audit` はHigh 5件（Expo CLI、その依存のnode-forge 1.4.0 / Zod 3、および上位パッケージ）を報告。サーバーのmanifest検証は修正版Zod 4.6.7、OIDCはjose、App Attestはnode-app-attestを使用し、Expo CLIの署名検証を利用しない。npmが提案するExpo 54へのダウングレードやZod 3→4の強制置換はCLIを壊すため未実施。開発ツールの公式互換更新を追跡し、開発サーバーを公開サービスとして運用しない。

今回のログ: `extended-check.log`、`extended-integration.log`、`extended-photo-tests.log`、`ios-build-extended.log`、`extended-kotlin.log`、`extended-web-build.log`、`extended-worker-build.log`。画面証跡: `artifacts/justtaken-extended-photo-preview.png`。シミュレーターでは撮影を有効化せず、未対応表示を確認した。

## LP・先行登録

2026-10-25、承認デザインv2を実装して https://justtaken.app/ に公開。写真ギャラリー、撮影機能のタブ、FAQ、撮影証明への導線、D1への先行登録・取り消し・180日の保持期限を実装。案内メールの配信基盤は未接続。[詳細](landing-page.md)。

## 運営表記・写真のロゴ

運営を株式会社IMAKAIとして掲載。アプリの写真に取り外せるロゴ表示を追加し、端末内で設定を保持する。LPでも切り替えを体験できる。原本の再圧縮やロゴ焼き込みは行わず、書き出す原本は従来のまま。[範囲と検証](photo-watermark.md)。
