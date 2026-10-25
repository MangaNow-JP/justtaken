# 原画を保持する写真・60秒動画

新規写真は[HEIF・RAW・HDR写真の原本保存](photo-originals.md)の `capture-v3` へ更新済み。以下の写真v2処理は旧下書きとの互換用で、動画の記述は現行仕様。

2026-10-25の追加指定を反映した `capture-v2`。写真の縮小・再JPEG化、動画の720p/低ビットレート変換、音声の再エンコードを廃止した。参照仕様v1.1は原本として変更せず保存している。

## 保存するもの

| 種類   | 撮影と保存                                                                                   | 上限                                    |
| ------ | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| 写真   | カメラが生成したJPEGの圧縮画素とICCを保持。EXIFは向きだけの固定形式に置換し、GPS/XMP等を除く | 64 MiB、長辺16,384、200 MP              |
| 動画   | H.264 / HEVCとAAC-LCの圧縮サンプルを保持。MP4の入れ物を作り直し、プライバシー情報を除く      | 60秒、512 MiB、最大4096×2160相当、60fps |
| 表示用 | 写真のサムネイル、動画のポスターを別JPEGとして作る                                           | 長辺480、64 KiB                         |

撮影は前後カメラを選択できる。写真はiOSの品質優先・最大対応寸法、Androidの品質優先・最高JPEG解像度を指定。動画は最大4K/30fpsを優先し、レンズが対応する解像度へ撮影開始前にフォールバックする。Androidでは対応時にHLG 10-bitを選び、iOSではカメラの自動HDR調整を有効にする。録画後に解像度や音声を変換しない。60fpsは保存・検証の対応上限で、今回のカメラUIは30fps撮影。

HEVC 8/10-bit、SDR/HLG/PQ、回転行列を保持する。AppleのHEVC Main10/HLG出力に含まれるDolby Vision 8.4設定も保持・構造検査する。HDRの見え方は再生端末に依存する。非対応端末向けの別SDR動画は現時点では生成しない。

「原画」はこのアプリのカメラAPIが生成した画像・映像を指す。標準カメラアプリ独自の夜景・多眼合成・48/200MPモードすべてと同一の画質を保証するものではない。写真v2は通常JPEGの画素とICCを保持し、メタデータのみ置換していた。新規v3はHEIF・RAW・HDRゲインマップに対応し、ファイル全体を変更せず保持する。

WebPへの変換は行わない。WebPには可逆と非可逆があり、非可逆は情報を失う。可逆でもHDR・色管理・向き等の別条件を確認する必要があるため、v2原本はJPEGのまま、新規v3原本はカメラのJPEG/HEIF/DNGのまま保持する。軽量表示だけを別ファイルにする。

## 操作と転送

1. ログイン・端末認証後、写真/動画、イン/アウトカメラ、音声の有無を選ぶ。マイク拒否時は無音で撮影可能。
2. 動画は停止ボタンまたは自動停止で保存。末尾音声等を含め60秒内に収めるため、録画停止は59.8秒を目安に設定する。61秒など上限外の入力は切り詰めず拒否する。
3. 原画とプレビューを確定し、撮影記録をコミット。画質を下げて容量制限へ収める処理はない。容量超過なら理由を示し、投稿を確定しない。
4. 8 MiBを超えるファイルは8 MiBずつ分割送信する。サーバーが受領したpart番号・hash・R2 ETagを保持するので、通信断/アプリ再起動後は同じ下書きから未送信部分を送れる。端末のアクセストークン失効時も、ログインを更新して同じ下書きから再送する。
5. 全ファイルの照合後に投稿を保存。内容審査が終わるまでは本人だけが閲覧できる。写真は「原画を表示」、動画はタップ再生・初期ミュート。フィードで原本を自動取得しない。

録画中のレンズ切替、前後同時録画、複数クリップ合成は含まない。転送はforegroundで、OS background transferは未実装。開発版の共有保存枠を2 GiBへ拡大した（原画・プレビュー・検証票の実サイズを予約/精算）。料金プランの決定ではなく、リモートリソースや課金設定は変更していない。

## 撮影認証

録画開始時/シャッター時のnonceとnative所有ファイルを結び付ける。原画/プレビューのSHA-256、寸法、向き、動画時間・fps・codec・bit depth・color transfer・音声有無をmanifestへ含め、App Attest / Play Integrityで束縛する。

分割送信のpartごとにSHA-256を照合し、クライアントのETagは信用しない。組み立て済みという状態だけでは認証しない。最終照合時にR2をストリームで読み、全ファイルSHA-256・JPEG/MP4構造・寸法・向き・codec・色・音声・時間・サンプルoffsetを検査し、その同じデータを不変の原本へ保存する。動画全体をWorkerメモリーに展開しない。moovの上限は512 KiB。

期限は従来どおりコミット5分、アップロード24時間。キャンセル/期限切れは分割送信も拒否し、不完全なmultipartを中止する。R2作成直後のプロセスクラッシュ等でDOへ記録されなかったmultipartには、リモート側の「未完了multipartを中止」lifecycleも必要。参照期限より短くしない。

`capture-v1`の下書き・撮影記録は旧制限のまま受け入れる。過去の縮小済みデータを原画へ復元したと表示しない。JPEG/MP4検査は構造検証であり、全フレームのデコードや写っている内容の真偽を保証しない。

## 確認した範囲

- Swiftの実AVFoundationでH.264、AAC音声あり/無音、4K HEVC、4K HLG 10-bit、59秒動画を生成。アプリのパススルー処理前後の圧縮サンプル数・SHA-256が全トラックで一致。61秒は拒否。
- ImageIOで4032×3024 / Display P3 / 向き6 / GPS付きの合成JPEGを生成。圧縮画素・ICC・デコード画素の一致、向き保持、GPS除去を確認。AndroidのJPEG処理もJVMで実行し同じ出力を確認。
- 実workerd/SQLite DO/D1/R2の結合試験で、署名・分割送信・再開・同一part再送・hash競合・サイズ不一致・全体hash偽装・キャンセル・期限・投稿・原本のバイト一致・ACLを検証。
- iOS Simulatorアプリ全体をビルド。Androidは実CameraXライブラリで変更したネイティブコードを型検査（Expo bridgeの型はstub）。Android APK全体と両OS実機カメラ/マイクは未確認。

Apple/Google専用アプリ登録、HTTPS API配置と本物のApp Attest/Play Integrity試験は未完了。検証用アカウント/鍵はテスト専用Workerへだけ注入し、本番の認証回避機能は置かない。

## 再現と一次資料

`npm run check`、`npm run test:integration`。ネイティブの実データ生成は `scripts/generate-original-video.swift`、`scripts/generate-original-photo.swift`、`scripts/test-original-photo.kt`。結果ログは `artifacts/original-*.log`。

[Apple passthrough](https://developer.apple.com/documentation/avfoundation/avassetexportpresetpassthrough)、[Apple HDR metadata](https://developer.apple.com/documentation/technotes/tn3145-hdr-video-metadata)、[CameraX VideoCapabilities](https://developer.android.com/reference/androidx/camera/video/VideoCapabilities)、[R2 multipart](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)、[WebPの可逆/非可逆](https://developers.google.com/speed/webp)。接続と実機試験は[セットアップ](setup-accounts.md)。
