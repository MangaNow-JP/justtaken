# 第三者時刻認証と公開監査ログ

実装日：2026-10-25。対象はSNS投稿の有無を問わない写真・動画の撮影証明。原本には一切書き込まない。

## 証拠の構成

1. 既存の撮影経路・完全manifest・原本SHA-256・時刻を含むES256証明書を固定する。新しい証明には `anchorPolicy: rfc3161-rekor-v1` を署名して含める。
2. 証明書のJWS文字列全体のSHA-256とランダム128bit nonceを、Sigstore TSAへRFC 3161要求として送る。
3. 応答のCMS署名、固定したTSA証明書／rootとの関係、証明書有効期間、時刻専用critical EKU、ESS SigningCertificateV2、nonce、SHA-256 messageImprintを検証する。TSAの時刻は**その時刻までに証明書が存在したこと**を示す。端末の撮影日時を保証しない。
4. `JustTaken external proof v1\n<certificate SHA-256>\n<DER timestamp response SHA-256>\n` を署名する。この値のハッシュ、署名、サービス公開鍵をRekorへ `hashedrekord 0.0.1` として登録する。
5. RekorのSigned Entry Timestamp署名、署名付きcheckpoint、Merkle収録証明、登録内容と証明書／時刻応答の結び付きを検証してから、`anchors` を保存する。Rekorの `integratedTime` はTSA時刻として使わない。

現在の公式signing configで提供されるRekor v1を使用する。v1はメンテナンスモードであり、将来のv2移行では別の署名付きcheckpoint／tile読取方式が必要。旧証拠・旧信頼鍵を保持し、単純なURL置換で移行しない。

第三者へ送るのは不透明なハッシュ、nonce、サービス署名／公開鍵だけ。原本、プレビュー、ファイル名、撮影アカウントID、公開証明ID、証明書本文は送らない。証明書にはランダムUUIDが含まれるため、既知の画像だけからログの値を計算できない。ただしサービス公開鍵による登録の関連付け・登録時刻や件数の観測は可能。公開ログへの登録は取り消せず、アプリから原本を削除してもハッシュは残る。

## 独立して検証する

ブラウザ `/verify` は、同梱した固定信頼鍵を使って外部署名を検証し、**Rekorへ直接**問い合わせる。収録時のcheckpointから現在までのRFC 6962整合性証明を検証する。以前保存した同じtreeのcheckpointとも比較する。32bitを超える木サイズはBigIntで処理する。

受け手のブラウザは、発行元＋proofIdごとの証明書指紋と、署名付きcheckpointをlocalStorageに保存する。Web Locksで複数タブの初回記録・更新を排他制御し、対応しないブラウザでは保存不可を明示する。同じIDで異なる証明書が届けば、運営が新しく署名していても拒否する。第三者証拠の欠落は未完了／除去として警告し、外部署名・収録の不正は検証失敗として原本照合を無効にする。外部への通信障害は最新の連続性が「未確認」となる。ブラウザの保存を拒否する設定では履歴を保持できないことを表示する。

**運営が配信するJavaScript自体の改変には、同じ運営の検証ページだけでは対抗できない。** 受け手・監査者は検証ツール、公開信頼鍵、証明書、履歴を運営とは別の管理下へ保管する。

```sh
node scripts/build-proof-cli.mjs
# 生成物：artifacts/verifier/justtaken-verify.mjs と SHA256SUMS
# 上の生成物はNode 22だけで動作し、npmパッケージの実行時インストールは不要。
node justtaken-verify.mjs proof.json original.heic trusted-issuer-jwks.json https://official-api.example \
  --online --state=recipient-history.json
```

`--online` では独立ログへの直接照会・履歴の連続性検証に失敗したら終了コード1。省略時もTSA署名とログ収録証明はオフライン検証するが、最新履歴・鍵失効・共有リンクの有効性は保証しない。`--state` のファイルは受け手自身が保持する。排他的 `.lock` と一時ファイルからのrenameで競合・途中書き込みを防ぐ。クラッシュ後の古いlockは実行中プロセスがないことを確認して回収する。

外部証拠がないファイルはCLIでは既定で拒否する。明示的な `--allow-unanchored` を指定した場合だけ運営署名と原本の一致を検証し、結果には `unanchored` と表示する。開発・テスト証明は別途 `--allow-development` が必要。

信頼材料は `workers/api/src/anchor-trust.ts` に固定。取得元はSigstore公式root-signingの `trusted_root.json`、取得snapshotは `workers/api/trust/sigstore-root.json`、そのSHA-256をコードに記録する。初回取得は公式HTTPS経由の手動bootstrap。TUF自動更新は未実装であり、ファイルや証明応答から任意の新しい信頼鍵を取り込まない。鍵・TSA証明書の更新や失効時は公式の信頼情報を独立に確認し、レビューした検証ツールの版を配布する。現在の検証は固定した信頼材料時点の結果で、オンラインOCSP/CRL失効確認を実装したものではない。

## サーバー処理と運用

- `PROOF_ANCHOR_PROVIDER=sigstore-v1` で有効。`disabled` または未設定なら「未接続」。自社署名による代替はしない。
- `0005_external_anchors.sql` を適用。証明発行直後にD1へ登録し、nonce・証明書digestを固定。取得済みtimestamp応答・Rekor要求署名を各段階で保存する。
- 同一証明の処理はD1の条件付きUPDATEで2分leaseを取得。外部呼び出しは各20秒、redirect拒否、応答サイズ制限付き。provider URLは固定で証明ファイルから読み込まない。
- 証明発行時と `POST /v1/proofs/:id/anchor` で処理。障害時は保留し、指数バックオフ（最大24時間）。手動更新もバックオフを守る。cronは5分ごとに最大5件を処理する。大量利用の前にバックログ監視・キュー化・provider利用量を設計する。
- 保存済みRekor要求を再送し、409のLocationは固定origin＋限定pathだけを許可して既存記録を回収。処理完了前に第三者署名を再検証する。`anchored` になるまで成功扱いしない。
- `GET /v1/proofs` と個別取得は `anchoring.state` を返す。原本・証明の所有者ACLは継続。共有APIは匿名で原本を返さない。
- 発行済み証明とDO内のmanifest全体、撮影・受付・照合日時、原本属性が一致することを再検査する。保存記録だけの変更は409で拒否する。
- 審査未完了投稿は従来通り公開しない。第三者証明の取得は、SNSの内容審査許可を意味しない。

ローカルとCloudflare本番D1へ適用済み。`https://justtaken.app` に本番APIを配置し、5分ごとのリモートcronを登録した。[Cloudflare実環境](cloudflare-production.md)を参照。ローカル開発サーバーだけではcronは自動運用されないため、保留中はアプリから更新するかローカルscheduled eventを手動発火する。Apple/Googleのアプリ登録と実機認証は引き続き必要。

2026-10-25 22:05:36 JST、本番cronの正常終了を確認した（対象待ち証明0件、例外0件）。実機で発行する証明の外部再送試験は、専用アプリ登録の接続後に行う。

## 検出できることと限界

| 操作                                              | 検出・扱い                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 元ファイルを1byte変更                             | 原本SHA-256不一致                                                                             |
| 証明書・timestamp・公開ログ証拠を変更             | 第三者署名／messageImprint／nonce／収録証明不一致                                             |
| 運営が過去の同じproofIdを変更して再署名           | 過去証明書を保持した受け手の指紋と不一致。旧第三者証拠の流用も拒否                            |
| ログが同じサイズの別rootを提示                    | 保持したcheckpointとのfork検出                                                                |
| 現在のログが過去より小さなtreeを提示              | rollback検出                                                                                  |
| 新しいrootが過去の履歴を引き継がない              | 整合性証明不一致                                                                              |
| 過去の有効なbundleをオフラインで開く              | 歴史的証拠として有効。古い収録checkpoint自体は攻撃とみなさない                                |
| 独立ログへ接続できない                            | 過去の署名と収録は検証可能、最新連続性は未確認                                                |
| 全く初めての受け手へ新しいproofId／新規証明を提示 | 保持した過去証明がなければ置換前の存在を自動発見できない                                      |
| 運営が登録前の記録を削除／発行拒否                | この仕組みだけでは防止しない。既に受領・外部登録した証拠を別保管する                          |
| Sigstore TSAとRekorの同時侵害／共謀               | 両方はJustTaken運営から独立しているが、互いに異なる組織ではない。多組織witness quorumは未実装 |
| ログが相手ごとに整合する別履歴を見せ続ける        | 異なるcheckpointが比較されれば検出可能。全受信者横断のgossip／監査者コサインは未実装          |

「改ざん不可能」や「被写体が現実の出来事である」とは表示しない。出願可否や特許性の判定はこの実装とは別の調査事項。

## 検証済み

- 実Sigstore TSAから合成証明の時刻応答を取得：2026-10-25 12:28:07 UTC。
- 実Rekorへ不透明な合成commitmentを登録。署名・収録・現在checkpointへの整合性・409再送を検証。
- ブラウザで外部署名検証、Rekor直接照会、元HEIFのバイト一致、証拠改変の拒否を確認。
- ユニットでroot／時刻／nonce／本文／index／pathの変更、同じIDの再署名、fork・rollback、1～257leafの平衡／非平衡Merkle treeを検査。
- 実workerd＋D1で外部通信を隔離し、実サービスから保存した署名応答を再生。障害時保留、lease並行制御、バックオフ、timestamp再利用、同一log要求の再送、完了・記録差替えを検査。

合成fixtureは実センサーによる撮影証明ではない。テスト専用入口を本番へデプロイしない。

参考： [Sigstore timestamps](https://docs.sigstore.dev/cosign/verifying/timestamps/)、[Rekor API](https://github.com/sigstore/rekor/blob/main/openapi.yaml)、[公式信頼情報](https://github.com/sigstore/root-signing/tree/main/targets)、[RFC 3161](https://www.rfc-editor.org/rfc/rfc3161)、[RFC 6962](https://www.rfc-editor.org/rfc/rfc6962)。
