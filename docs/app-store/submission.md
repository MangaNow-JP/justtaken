# JustTaken iOS 初回申請

更新：2026-10-30。App Store Connectで1.0.0 (3) の「提出準備完了」を確認。Appleログインは本人の実機で成功報告あり。撮影証明保存の実機エラーを調査中で、審査提出・公開は未完了。

## Apple登録

- 法人：Imakai Inc.（株式会社IMAKAI）
- Team ID：`CQC25QD69U`
- Explicit Bundle ID：`app.justtaken.ios`（2026-10-29登録）
- Capabilities：Sign in with Apple（Primary App ID）、App Attest
- App Store Connect App ID：`6828439735`
- SKU：`justtaken-ios`、プライマリ言語：日本語、プラットフォーム：iOS
- [申請ページ](https://appstoreconnect.apple.com/apps/6828439735/distribution/ios/version/inflight)
- バージョン：1.0.0、初回ビルド番号：1。再アップロード時は番号を増やす。

登録情報は `apps/mobile/ios-release.json`、日本語の掲載文は `ja-JP.json`。
日本語の概要・プロモーション文・キーワード・各URL・著作権・1.0.0をApp Store Connectへ保存済み。
サブタイトル、カテゴリ（写真／ビデオ、ソーシャルネットワーキング）、プライバシーポリシーURLも保存済み。
リリース方法は手動。掲載文は申請用下書きであり、実機受入試験の結果と一致することを提出前に再確認する。

## ローカルの配布用ビルド

```sh
npm run ios:release:config
npm run ios:release:prebuild
# apps/mobile/ios で pod install（Ruby/CocoaPodsが必要）
# 署名設定前のコンパイルのみ（アップロードには使用できない）
node scripts/ios-release.mjs compile
IOS_BUILD_NUMBER=4 npm run ios:release:archive
# archive成功後、署名付きIPAをローカルに書き出す
IOS_BUILD_NUMBER=4 npm run ios:release:export
# 実行するとAppleへビルドを送信する（審査提出・公開は別操作）
IOS_BUILD_NUMBER=4 npm run ios:release:upload
```

本番ビルドコマンドは正式Bundle ID・Team ID・HTTPS API・production App Attestを同時に設定する。
ネイティブ設定だけを本番にしてJSがlocalhostへ向くことを防ぐため、archive時も同じ環境変数を渡す。
`prebuild` は生成済みiOSディレクトリを再作成することがある。ネイティブ実装の正本は `native/` とconfig pluginに置く。
Apple Distribution証明書とJustTaken専用のApp Store配布プロファイルを作成・登録済み。archiveはアプリのReleaseターゲットだけに手動署名設定を適用し、CocoaPodsターゲットにはアプリ用プロファイルを適用しない。署名を無効化した成果物はアップロード不可。
archiveは `artifacts/JustTaken-<build>.xcarchive`。1.0.0 (3) の署名付きarchiveが成功。次回の変更は未使用のビルド4以降にする。
export先は `artifacts/ios-export-<build>`。exportはアップロードを行わない。
実機用IPAは `artifacts/ios-device-3/JustTaken.ipa`。App Store向けは同じarchiveからapp-store-connect方式で送信する。
署名検証結果は `artifacts/ios-release-validation.json`。IPAの完成は、実機受入試験やApp Store審査への準備完了を意味しない。

### 以前の配布用署名（2026-10-29、現在は不使用）

- Apple Distribution: Imakai Inc. (`CQC25QD69U`)、証明書ID `V28ZZR3PNB`、有効期限2027-10-29。
- 証明書SHA-1：`5E554D42BAAFF6B7DCE78D246F85E4975040C6A2`。秘密鍵はこのMacのloginキーチェーンに登録し、一時生成ファイルは削除済み。既存証明書の失効は行っていない。
- プロファイル：`JustTaken App Store 2026`、UUID `8850d219-4726-4197-a83b-44d5a1bb01e6`。Sign in with Appleとproduction App Attestを許可し、署名証明書の一致も確認済み。
- 署名付きarchiveはフレームワーク署名時に `errSecInternalComponent` で失敗。鍵使用確認でパスワードが拒否され、以前のパスワードも不明なため、下記の専用キーチェーンに移行した。既存キーチェーンのリセット・アクセス制御の緩和・証明書の失効は行っていない。

### 現在の配布用署名（専用キーチェーン、2026-10-30）

新しい専用鍵・キーチェーン・パスワードのローカル保存・codesignの鍵使用許可について、ユーザーから明示承認を得て作成済み。作業用バイナリへの試験署名に成功し、旧キーチェーンのパスワード確認が不要になった。

- 証明書：Apple Distribution: Imakai Inc. (`CQC25QD69U`)、ID `ZV7NS3DGM5`、有効期限2027-10-30。
- 証明書SHA-1：`993165B5C91495825706360AD9D8F3D3F393487F`。発行証明書とCSRの公開鍵一致を検証済み。
- プロファイル：`JustTaken App Store Isolated 2026`、UUID `cf650798-2d03-490a-ba9a-c69971914e83`、ポータルID `TLMCXUHK8Q`。
- 正式App ID、Sign in with Apple、本番App Attest、`get-task-allow=false`、埋め込み証明書のSHA-1を検証後、Xcodeへ登録済み。

保存先はGit管理外の `artifacts/ios-signing-isolated/`。ディレクトリは0700、暗号化キーチェーンとランダムな専用パスワードのファイルは0600。鍵は取り込み時に非抽出可能とし、取り込み後に平文の鍵ファイルを削除した。codesignのアクセス設定はこの新しい専用鍵のみが対象。
`scripts/ios-signing-keychain.mjs` がarchive/export/uploadの間だけ専用キーチェーンを解錠して検索先へ追加し、処理終了時に元の検索先へ戻して専用キーチェーンをロックする。archive/export/upload終了後のロックと検索先の復元も読み取り確認済み。既存キーチェーンの中身には変更を加えない。
別の保管先を利用する場合は `JUSTTAKEN_SIGNING_DIRECTORY` を指定する。秘密情報はソース・ログ・チャットへ出力しない。専用フォルダはGitから復元できないため、削除せず安全なローカルバックアップを管理する。

### 本番との統合（2026-10-30）

本番バージョン `063ac469-38ff-4a43-9954-05cd6b9e9b2d` のソースマップから、Git未反映だった18歳以上の確認、同意、通報・ブロック、削除処理と公開ページを回収して統合。既存のAndroid証明書・パッケージ・戻り先を維持。既存D1の0007〜0011は適用済みの名前とDDLを復元し、今回の追加は0012だけ。

本番バージョン `3eca2045-47fa-47b0-8c66-78fe63dc5516` に反映済み。公開スモークテスト31項目成功。Apple/Google認証・撮影認証・外部アンカーがhealthで有効。ただし実際のApple認証・App Attest成功は実機で別途確認する。

Sign in with AppleキーID `QNKKQD8FKL`。秘密鍵・PROVIDER_TOKEN_KEYの保存をそれぞれユーザーが明示承認。MacではGit除外のowner-onlyフォルダ、本番ではCloudflare Secretに保存。値をログ・Gitへ出力しない。

## 契約の確認

無料アプリ契約は有効。有料アプリ契約の更新通知はあるが、今回は同意していない。有料化時はAccount Holderの確認が必要。EU向け配信にはトレーダーステータスも未設定。

## 現在の状態（2026-10-30）

- App Store Connectで1.0.0 (3) が「提出準備完了」。アップロード時刻は23:39 JST。審査提出・公開は未完了。
- App Privacyの11種類を本人の確認・同意後に公開済み。年齢レーティングも回答承認後に18歳以上として保存済み（地域により相当区分）。
- 審査連絡先は本人指定の氏名・メール・電話番号をApp Store Connectへ保存済み。個人の連絡先はGitへ保存しない。
- Apple Sign in専用キーとprovider token暗号化鍵を、本人の明示承認後に本番Cloudflare Secretと権限0600のGit管理外ファイルへ保存済み。
- 本番にあった未同期のAndroid・認証・成人自己申告・退会・Web設定を回収・照合して保持。D1 migration 0012を適用済み。
- 接続iPhoneにビルド2をインストールし、起動を確認。本人からAppleログイン成功の報告を受けた。本番にも暗号化した連携トークン1件の保存を確認。
- 実機で8064×6048のHDRゲインマップ付きJPEGの撮影・下書き表示を確認。保存・撮影証明の作成でエラー報告があり、調査中。撮影証明の実機成功を主張しない。
- ビルド3のAd Hoc IPAも書き出し・codesign厳格検証済み。実機の進行中の確認を中断しないため、インストールは確認の区切りで行う。

## 残る提出条件

1. 実機の撮影証明保存エラーを解消し、本番App Attest・原画保存・外部時刻認証・共有証明の一連の動作を確認する。
2. 前後カメラ、音声あり/なし、60秒自動停止、GPS ON/OFF、対応端末でHEIF/RAW/HDR、下書き再送を実機で確認する。
3. 通報・ブロックの実機確認と運営者アカウントの確認。MODERATOR_USER_IDSの対象アカウントは未設定。掲載前確認と通報対応を実運用できるようにする。
4. アカウント削除は統合テスト済み。実機で削除する場合は本人が削除対象を確認し、保管したいデータを先に取得する。
5. 最終配布ビルドの実画面でスクリーンショットを作成する。開発用プレビューや架空の認証成功画面を審査資料に使用しない。
6. コンテンツ配信権、配信地域・価格、必要な輸出コンプライアンスを完成させ、審査担当者のアクセス方法と実測結果を審査メモへ記載する。
7. 最終ビルドをバージョンに紐付け、必須項目を確認してから審査提出する。リリースは手動のまま。

## 実装と検証

- 同意確認・18歳以上の自己申告を維持。未同意でも設定とアカウント削除へ進める。
- Apple authorization codeをサーバーで交換し、refresh tokenをユーザーに結び付けてAES-GCM暗号化保存。Googleもopenidのみのoffline grantを取得し、退会時に失効させる。
- 退会受付でセッションと共有を停止。物理削除は段階実行し、送信中のファイル対策として24時間5分後に二巡目を行う。外部障害は再試行し、秘密の受付控えでログアウト後も進捗を確認できる。通常25時間以内、同一アカウントの再登録は31日制限。外部公開監査ログのハッシュは消去できない。
- 投稿・ユーザーの通報、ブロック、自分の投稿削除、運営の原本確認と掲載判定・アカウント停止を実装。競合更新を拒否し操作監査を保存する。
- ネイティブ版からサンプルのいいね・コメント・探索・通知・ブックマークを除外。ブラウザのデザインプレビューはサンプルと区別する。
- 型チェック、単体104件、実workerd/SQLite/D1/R2の既存統合532件、認証・退会・通報の統合60件が成功。診断追加後も再実行して全件成功。
- 本番公開エンドポイント31チェック成功。これは本人の実機試験の代替ではない。
- 認証失敗の診断には固定の処理段階・エラー分類だけを記録。トークン、nonce、ユーザーID、リクエスト本文は出力しない。
- ビルド2は組み込みReact.framework内のdSYMでApple検証に失敗。ビルド3で組み込みから除外し、archiveの独立したdSYMsに保持してアップロード成功。
- ExpoImage/SDWebImage/ReactのUUID一致dSYMを収集。ReactNativeDependencies/hermesvmの配布dSYM不足はクラッシュ解析上の制約として残る。架空のシンボルは生成しない。
- 専用Ad Hoc profile: `JustTaken iPhone Test 2026`、UUID `fd49c65d-042e-4719-b71d-7dd5a997df2b`。登録済みiPhone1台を対象。

## App Privacy

11種類すべてアプリ機能目的、アカウント関連付け、広告追跡なし。アプリ内Privacy Manifestと照合済み。

| Appleの区分              | 実際の用途                            |
| ------------------------ | ------------------------------------- |
| 名前                     | ユーザーが設定する表示名              |
| 写真またはビデオ         | 原画、プレビュー、撮影証明            |
| オーディオデータ         | 許可した動画内音声                    |
| その他のユーザコンテンツ | キャプション・撮影記録                |
| カスタマーサポート       | 通報・問い合わせ                      |
| ユーザID                 | Apple/Google sub由来のアカウントID    |
| デバイスID               | installation ID・App Attestキー識別子 |
| 詳細な位置情報           | GPS ONかつOS許可時の本人向け撮影位置  |
| おおよその場所           | OSから概略の位置情報が与えられる場合  |
| その他の診断データ       | 動作・障害・安全性の診断              |
| その他のデータタイプ     | 同意・18歳以上の自己申告等            |

Apple/Googleの要求scopeは氏名・メールを取得しない構成。取得範囲を変えた場合は申告も更新する。

## 記録

Git管理外の `artifacts/` に保存：

- `store-release-auth-diagnostics-check.log` / `store-release-auth-diagnostics-integration.log`
- `store-release-deploy.log` / `store-release-auth-diagnostics-deploy.log`
- `store-release-production-checks.json`
- `ios-release-3-archive.log` / `ios-release-3-upload.log` / `ios-release-3-device-export.log`
- `app-store-build3-ready.png` / `app-store-privacy-published.png` / `app-store-age18-saved.png`

## 公式参照

- [Apple審査ガイドライン（1.2 UGC / 2.1 完成度 / 2.2 ベータ配布）](https://developer.apple.com/app-store/review/guidelines/)
- [アカウント削除](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/)
- [App Privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
- [収集データ型](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype)
- [スクリーンショット](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots/)
- [Expoのローカル配布用ビルド](https://docs.expo.dev/guides/local-app-production/)
