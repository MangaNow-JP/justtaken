# JustTaken native capture

Swift/AVFoundation・Kotlin/CameraX/Camera2でカメラ所有のファイルだけを扱うExpo Module。JSに公開するのは撮影UUID、撮影前session、端末登録、handleからのmanifest/proof、送信・破棄。任意パス/URL/digestの署名APIはない。

`captureSession`をシャッター時点で固定し、private・バックアップ対象外のディレクトリへ保存。元のnonceの差替えは禁止。App Attest assertionは再送で再利用し、Play Integrityは同じmanifestをrequestHashへ束縛する。サーバーcounter/nonceが正本。

新規写真は`capture-v3`。JPEG/HEIF/DNGをファイル全体のまま保持し、HDRゲインマップ・色・RAW現像情報を含めてSHA-256を束縛する。RAW+JPEGは同じ撮影からの両コールバックを待つ。プレビューだけを480px/64KiBへ縮小。レンズの対応形式をUIへ返し、未対応時のJPEG変換はしない。旧下書きは保存されたpolicyVersionを使用し、未保存ならv1を維持。詳細は[HEIF・RAW・HDR](../../docs/photo-originals.md)。

動画は最大4K/30fpsの対応解像度、前後カメラ、音声/無音。iOSはAVAssetExportPresetPassthrough、AndroidはMediaExtractor/MediaMuxerで映像・AACを再エンコードせずMP4へ保存する。音声をmono/低ビットレートに変換しない。HEVCのbit depth、色のtransfer、回転を保持。native停止59.8秒、確定上限60秒/512MiB、容量超過時の再圧縮はない。

8MiBを超える原画は分割送信。固定HTTPS originのみ、redirect禁止。各partのhashとサーバー受領リストにより手動再送/再起動後に再開。原本全体をJSへ渡さない。iOSは保護付き一時ファイルとURLSession、Androidは固定長HTTPSを使う。転送はforeground。

原画/プレビュー確定後にhashを計算し、送信前にもnativeファイルを照合する。シミュレーターやWebには撮影証跡の代替生成を設けない。本物のApp Attest/Play Integrityには専用登録と実機が必要。

詳細・制限・テストは[原画保存](../../docs/video-capture.md)、接続は[設定手順](../../docs/setup-accounts.md)。
