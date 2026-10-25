# 撮影時の位置情報（GPS）

2026-10-25の追加要望により、初版仕様の「GPSを取得しない」を変更。設定 → 「撮影時の位置情報（GPS）」からこの端末でオン／オフを保存する。初期値はOFF。Webは設定の表示プレビューのみで、ブラウザのGeolocation APIを呼ばない。実際の取得は専用アプリの新しいネイティブビルドが必要。

## 動作

- ON操作時だけiOSの使用中許可／Androidの位置権限を要求。拒否時は有効にせず、設定画面への導線を出す。OSの「おおよその位置」も尊重する。
- カメラ画面が前景にある間だけ位置更新を受け取る。カメラを閉じる、アプリを背景へ移す、OFFへ切り替えると停止し、メモリー内の測位値も破棄する。背景取得権限・背景サービス・追跡経路は使わない。
- 写真と動画、前後カメラ、JPEG/HEIF/RAW/ProRAW/HDRの共通経路で、撮影開始時の最新サンプルをスナップショットする。動画は開始位置1点だけで、60秒上限や音声・画質には影響しない。
- 15秒を超える古い値、未来の値、範囲外、無効な精度、OSが模擬位置と示す値は記録しない。測位できなくても撮影は続き、`unavailable` と表示する。OFFは `off`、実装前の記録はフィールドなし。
- 撮影位置・精度・測位日時を撮影後の下書きで確認できる。サーバーに保存した撮影証明では「撮影位置を表示（自分のみ）」から取得する。位置の取得元はOSの位置サービスであり、衛星GPSだけに限定しない。

## 保存・署名・共有

ネイティブのカメラ処理だけが位置を取り出し、`draft.json` と `CaptureManifest.location` に格納。JSから座標や外部ファイルを与えるAPIはない。緯度／経度は1e-7度の整数、水平精度はmmの整数としてSwift・Kotlin・JSの署名用正規化を一致させる。測位日時・許可精度も署名の対象。APIは範囲・整数・時刻の鮮度・未知のフィールドを検査する。v2/v3で任意のフィールドとして扱い、既存記録も引き続き読める。

撮影後のcommitで位置情報もサーバーに送ることを設定画面に表示する。本人の撮影記録は非公開のDurable Objectに保存する。`GET /v1/proofs/:id/location` は所有者の認証を要求し、公開証明の署名と元のmanifest digestを照合してから返す。応答は `no-store`。公開証明、共有リンク、SNS投稿、原本、プレビュー、第三者時刻認証・公開監査ログには座標を出さない。原本ファイルにEXIF GPSを追加せず、既存のGPSメタデータ拒否も維持するので、保存済み写真・動画のバイト列は変わらない。

OFFへの変更は今後の撮影に適用し、過去の署名付き記録は書き換えない。原本・撮影証明を削除した場合や未完了撮影の期限切れ処理では、現行のサーバーレコードから位置フィールドを取り除く。ライフサイクル監査用のID・digest・ファイル属性は残す。Cloudflareの復元用履歴や、別途残した端末の下書きまで即時消去する意味ではない。

端末が報告した位置を記録したもので、物理的な撮影場所の真正性を保証しない。模擬位置の既知フラグ以外の偽装、電波環境、OS／端末侵害などは排除できない。共有証明に位置を付ける機能や地図・住所表示は今回追加していない。

## 検証

- TypeScript型検査、単体89件。位置の範囲・時刻・整数・署名変更、OFF／未取得への座標混入、公開証明への位置混入を拒否。
- 実workerd・SQLite DO・D1・R2の結合テスト532 assertions。GPSを変更したassertionの拒否、保存後改変の検出、所有者の取得、他人／未ログインの拒否、共有への座標非公開、原本バイト一致、削除時の現行レコードからの除去を確認。
- iOS Simulator向けのXcodeビルド成功。CoreLocation・新しい許可メソッド・写真／動画の保存連携をコンパイル。実機測位／権限ダイアログの操作試験は未実施。
- AndroidのCameraX・保存・位置処理を既存SDK/CameraX jarとExpo bridgeのcompile-only stubでKotlinコンパイル。APK全体と実機は未確認。
- Webビルド、設定のON/OFF、再読込後の保持、390px表示、console error/warningなしを確認。
- iOS利用説明と位置データのprivacy manifestを追加。AndroidはCOARSE/FINEを要求しBACKGROUNDを禁止。配布前にはApp Store／Google Playのデータ利用申告と実機試験も更新する。

証跡：`artifacts/gps/`。実機受入では両OSの精密／概算許可、拒否・取消、位置サービス停止、屋内で測位できない場合、ON/OFF・背景遷移・再起動、前後カメラ・写真各形式・音声動画・60秒、座標を持つ原本の非公開性を確認する。

実装の参照：
- [Apple 使用中の位置権限](https://developer.apple.com/documentation/corelocation/cllocationmanager/requestwheninuseauthorization())
- [Android 位置権限と概算位置](https://developer.android.com/develop/sensors-and-location/location/permissions/runtime)
- [Apple privacy manifestのデータ種別](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype)
- [Cloudflare SQLiteストレージと復元履歴](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
