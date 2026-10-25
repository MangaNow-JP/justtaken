# HEIF・RAW・HDR写真の原本保存

2026-10-25の追加指定を反映。新規写真は `capture-v3`、動画は既存の `capture-v2` を使用する。過去のv1/v2下書きは変更しない。

## 撮影できる形式

| 形式                       | iOS                                                  | Android                                              | 保存上限 |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------------------- | -------- |
| JPEG                       | AVCapturePhotoのJPEG                                 | CameraXのJPEG                                        | 128 MiB  |
| HEIF（HEIC）               | HEVC/HEIF出力対応レンズ                              | Camera2がHEIC出力を公開するレンズ                    | 128 MiB  |
| Bayer RAW（DNG）           | Bayer RAW対応レンズ                                  | CameraXのRAW+JPEG対応レンズ                          | 512 MiB  |
| Apple ProRAW（Linear DNG） | ProRAW対応機種・レンズ                               | 対象外                                               | 512 MiB  |
| HDRゲインマップ            | JPEG/HEIFにカメラが含めたApple/ISOゲインマップを保持 | 対応レンズのJPEG Ultra HDR。HEIFのゲインマップも保持 | 128 MiB  |

写真共通で長辺16,384ピクセル・200MP以内。共有開発枠は2 GiB。上限超過時に画質を落として収める処理はない。対応状況をレンズごとに問い合わせ、選択した形式を未対応の前面カメラ等へ切り替えた場合は撮影を止め、別の形式を選べるようにする。JPEGへ黙って変換しない。

iOSのカメラAPIには静止画ゲインマップを必ず出力させる共通スイッチがないため、HEIF/JPEGの出力に含まれるものを保持する。iOSでは独立したHDRボタンを有効化しない。AndroidのHDRボタンはAPI 34以上かつCameraXがUltra HDRを公開した場合だけ有効。要求したHDR撮影がゲインマップを返さなかった場合は失敗として扱う。

## 原本とプレビュー

カメラから受け取ったファイル全体をそのまま保存・ハッシュ化・送信する。再圧縮、縮小、JPEG/WebP化、色空間変換、RAW現像の焼き込み、EXIF再構築は行わない。ICC/色・向き・MPF/HEIFの補助画像・HDRメタデータ・DNGの校正/現像情報を含む全バイトが同一になる。

GPSは[撮影位置の設定](capture-location.md)で明示的にオンにした場合だけ取得し、原本とは別の撮影記録に保存する。カメラのファイル出力にはGPSを渡さない。標準GPS EXIF/XMPが見つかった場合は、原本を書き換えずに拒否する。機種・露出・レンズ・現像用のメタデータは原本に残る。メーカー独自ペイロードを含む全情報の匿名化を保証する機能ではない。

表示用だけを480px・64KiBのSDR JPEGへ別途縮小する。RAWは同じ撮影要求から得たJPEGをプレビュー生成に使い、iOS/AndroidともRAWとJPEGの両方の完了を待って下書きを1件発行する。外部ファイルの取り込みや任意ファイルを署名するAPIはない。

原本の表示にはExpo Imageを使用し、iOSのEDR表示、AndroidのHDRウィンドウを有効にする。ディスク・メモリーの画像キャッシュを無効化し、スクロール・画面遷移・バックグラウンド・grant期限で原本表示を閉じる。RAWの現像とHDRの見え方はOS/デコーダー/ディスプレイに依存し、Web等で表示できなくても保存原本は変わらない。標準カメラアプリ独自の夜景合成・画像処理や、全機種の最高画素モードとの同一性は保証しない。

## 撮影認証・送信・投稿

1. シャッター前のサーバーnonceをnative撮影要求へ束縛。
2. 原本・プレビューの全ファイルSHA-256、MIME、寸法、向き、`hasGainMap`、`preservation: camera-original`をmanifestへ含める。
3. nativeがファイルを再照合し、App Attest assertion / Play Integrity requestHashへ束縛。
4. 固定HTTPS originへ送信。8 MiBを超えるHEIF/RAWも動画と同じ分割送信・再開処理を通る。
5. R2のchecksumとストリームで全ファイルを照合し、不変の原本へ保存。その**同じ不変オブジェクト**を構造検査してからES256検証票を発行する。検査失敗後の再試行でも検査を省略しない。
6. 投稿・現在の閲覧権限・120秒のmedia grantを通して同じ原本を返す。認証未完了の原本にはgrantを出さない。公開には別途内容審査の許可が必要。

検査内容:

- JPEG: ストリームで全画像のフレーム/SOI/EOI、EXIF向き/GPS、MPFの画像数/位置/長さ、HDRメタデータと補助画像の存在。
- HEIF: HEICブランド、item情報、primary item、ispe、hvcC、ilocの範囲/外部参照禁止、grid/tmapと参照、Apple auxC / ISO tmapのゲインマップ、Exif。
- DNG: classic TIFFの型/範囲、循環IFD拒否、DNG version、Bayer/Linear RAW、寸法/DefaultCropSize、ビット数、strip/tile範囲、向き、GPS。

HEIF/DNGは64KiB単位のRange読込、16ページのキャッシュ、最大256読込とメタデータ上限でメモリー/処理を制限する。512MiBのRAW全体をWorkerメモリーへ展開しない。検査は構造・ハッシュの一致を扱い、全画素デコードや写っている内容の真偽を保証しない。AVIF、HEIFシーケンス、BigTIFF、外部参照、任意のカメラメーカーの全RAW形式は対象外。

## 検証と残る実機確認

- ImageIOで512×384と4032×3024のHEIF（SDR/HDR）・HDR JPEGを生成。OSデコーダーで寸法・向き・ゲインマップを確認。
- 合成Bayer DNG / Linear DNGをImageIOでデコード。これはApple ProRAW実写の試験ではない。
- manifest制限、GPS、破損MPF、循環TIFF、範囲外strip、HEIF外部参照、失われたゲインマップ、切断ファイル等を単体試験。
- 実workerd/D1/SQLite DO/R2の結合試験で、8形式/サイズと9MiB RAWの分割送信・再開・認証・投稿・取得を通し、全バイト一致を確認。未検証原本の閲覧/公開拒否も検証。
- iOS Simulatorのビルド・起動・未対応状態/形式選択UIを確認。Androidは実CameraX 1.6.2 jarによるKotlinソースコンパイル（Expo bridgeはcompile-only stub）。APK全体は未検証。

JustTaken専用のApple/Google登録と両OS実機が必要。前後カメラの対応一覧、HEIF/RAW/ProRAW/Ultra HDRの実写、全レンズでの向き、RAW+JPEGコールバック順序、電話/背景移行、低メモリー、通信断からの再開、実App Attest/Integrity、HDR画面での表示を確認してから公開する。現在の本番公開・プロバイダー設定・実機試験は未完了。

再現コマンド:

```sh
python3 scripts/generate-dng-fixtures.py
swiftc -parse-as-library -O scripts/generate-extended-photos.swift -o /tmp/justtaken-photo-fixtures
/tmp/justtaken-photo-fixtures workers/api/test/fixtures
/tmp/justtaken-photo-fixtures workers/api/test/fixtures --large
npm run check
npm run test:integration
npm run build:web
npm run build --workspace @justtaken/api
```

一次資料: [AppleのRAW/ProRAW撮影](https://developer.apple.com/documentation/avfoundation/capturing-photos-in-raw-and-apple-proraw-formats)、[AVCapturePhotoのファイル出力](<https://developer.apple.com/documentation/avfoundation/avcapturephoto/filedatarepresentation()>)、[CameraX ImageCapture](https://developer.android.com/reference/androidx/camera/core/ImageCapture)、[Ultra HDR](https://developer.android.com/media/platform/hdr-image-format)、[Expo ImageのHDR表示](https://docs.expo.dev/versions/latest/sdk/image/#preferhighdynamicrange)。
