import type { CaptureLocation } from '@justtaken/contracts';
import { CaptureLocationRecord } from '../components/CaptureLocationRecord';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, ScrollView, Share, Text, View } from 'react-native';
import { Button, EmptyState, Icon } from '../components/UI';
import { appStyles as s } from '../appStyles';
import { colors as c } from '../theme';
import { API_URL } from '../services/api';
import {
  listProofs,
  getProofLocation,
  shareProof,
  revokeProofShares,
  exportProofFile,
  deleteProof,
  anchorProof,
  type VaultEntry,
} from '../services/proofs';

export function Proofs({ onCamera }: { onCamera: () => void }) {
  const [locations, setLocations] = useState<Record<string, CaptureLocation | null>>({});
  const [entries, setEntries] = useState<VaultEntry[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState('loading'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [link, setLink] = useState<{ id: string; url: string; expiresAt: number } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null),
    [days, setDays] = useState(7);
  const mounted = useRef(true);
  const running = useRef(false);
  async function load(before?: string) {
    const page = await listProofs(before);
    if (!mounted.current) return;
    setEntries((old) => (before ? [...old, ...page.proofs] : page.proofs));
    setCursor(page.nextCursor);
  }
  useEffect(() => {
    mounted.current = true;
    void load()
      .catch((e: Error) => {
        if (mounted.current) setError(e.message);
      })
      .finally(() => {
        if (mounted.current) setBusy('');
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(label: string, fn: () => Promise<void>) {
    if (busy || running.current) return;
    running.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : '処理を完了できませんでした。');
    } finally {
      running.current = false;
      if (mounted.current) setBusy('');
    }
  }
  return (
    <ScrollView contentContainerStyle={s.sheetContent}>
      <View style={s.notice}>
        <Icon name="shield" size={20} />
        <Text style={s.noticeText}>投稿しなくても残せる、あなたの撮影証明。</Text>
      </View>
      <Text style={s.bodyText}>
        原本と署名付き証明を保存します。第三者の時刻認証と公開監査ログには証明のハッシュだけを送り、受け手が運営の記録と照合できます。
      </Text>
      <Button
        secondary
        icon="external-link"
        onPress={() =>
          void Linking.openURL(API_URL + '/verify').catch(() =>
            setError('検証ページを開けませんでした。'),
          )
        }
      >
        証明を検証するページを開く
      </Button>
      {!!busy && (
        <View style={s.notice}>
          <ActivityIndicator color={c.ink} />
          <Text style={s.small}>{busy === 'loading' ? '撮影証明を読み込み中…' : busy}</Text>
        </View>
      )}
      {!!error && (
        <>
          <Text accessibilityRole="alert" style={{ color: c.red }}>
            {error}
          </Text>
          <Button secondary disabled={!!busy} onPress={() => void run('読み込み中…', () => load())}>
            一覧を読み直す
          </Button>
        </>
      )}
      {!!notice && (
        <Text accessibilityRole="alert" style={s.bodyText}>
          {notice}
        </Text>
      )}
      {!busy && !error && !entries.length && (
        <>
          <EmptyState icon="shield" title="撮影証明はまだありません">
            撮影後に「投稿せずに撮影証明を保存」を選んでください。
          </EmptyState>
          <Button icon="camera" onPress={onCamera}>
            撮影する
          </Button>
        </>
      )}
      {entries.length > 0 && (
        <>
          <Text style={s.sectionTitle}>新しく作成する共有リンクの期限</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[1, 7, 30].map((d) => (
              <Button key={d} secondary={days !== d} disabled={!!busy} onPress={() => setDays(d)}>
                {d}日
              </Button>
            ))}
          </View>
          <Text style={s.small}>
            リンクを知る人は証明と撮影アカウントIDを確認できます。実名・端末ID・位置情報・原本は公開されません。
          </Text>
        </>
      )}
      {entries.map(({ proof, available, activeShares, anchoring }) => {
        const id = proof.proofId,
          production =
            proof.evidence.deviceEnvironment === 'production' &&
            proof.evidence.serviceEnvironment === 'production';
        return (
          <View
            key={id}
            style={{ gap: 14, borderWidth: 1, borderColor: c.stone, borderRadius: 18, padding: 18 }}
          >
            <Text style={s.sectionTitle}>{proof.kind === 'video' ? '動画' : '写真'}の撮影証明</Text>
            <Text style={s.bodyText}>
              {new Date(proof.deviceCapturedAt).toLocaleString('ja-JP')}
            </Text>
            <Text style={s.small}>
              {proof.original.mime} · {(proof.original.bytes / 1048576).toFixed(1)} MiB
              {proof.original.hasGainMap ? ' · HDRゲインマップ' : ''}
            </Text>
            <Text style={s.small}>
              サーバー照合：{new Date(proof.serverVerifiedAt).toLocaleString('ja-JP')}
            </Text>
            <Text selectable style={s.small}>
              撮影アカウントID：{proof.creatorId}
            </Text>
            <Text selectable style={s.small}>
              証明ID：{id}
            </Text>
            {available &&
              (Object.prototype.hasOwnProperty.call(locations, id) ? (
                <>
                  <CaptureLocationRecord location={locations[id] ?? undefined} />
                  <Button
                    secondary
                    disabled={!!busy}
                    onPress={() =>
                      setLocations((old) => {
                        const next = { ...old };
                        delete next[id];
                        return next;
                      })
                    }
                  >
                    位置情報を隠す
                  </Button>
                </>
              ) : (
                <Button
                  secondary
                  icon="map-pin"
                  disabled={!!busy}
                  onPress={() =>
                    void run('撮影位置を読み込み中…', async () => {
                      const result = await getProofLocation(id);
                      if (mounted.current)
                        setLocations((old) => ({ ...old, [id]: result.location }));
                    })
                  }
                >
                  撮影位置を表示（自分のみ）
                </Button>
              ))}
            {!production && (
              <Text style={{ color: '#8a6017' }}>開発・テスト用の撮影証明です。</Text>
            )}
            <Text style={s.small}>
              {anchoring?.state === 'anchored'
                ? '第三者時刻認証・公開ログの証拠を保存済み。検証ページで確認できます。'
                : anchoring?.state === 'mismatch'
                  ? '保存された証明と監査記録が一致しません。共有を停止して確認してください。'
                  : anchoring?.state === 'not-configured'
                    ? '第三者認証サービスは未接続です。'
                    : '第三者時刻認証・公開ログへの登録は未完了です。自動再試行します。'}
            </Text>
            {available && anchoring?.state !== 'anchored' && (
              <Button
                secondary
                disabled={!!busy || anchoring?.state === 'mismatch'}
                onPress={() =>
                  void run('第三者の認証を確認中…', async () => {
                    const result = await anchorProof(id);
                    if (!mounted.current) return;
                    setNotice(
                      result.anchoring.state === 'anchored'
                        ? '第三者の時刻認証と公開ログへの登録が完了しました。'
                        : '第三者認証は未完了です。接続設定と再試行時刻に従って処理を続けます。',
                    );
                    await load();
                  })
                }
              >
                第三者認証の状態を更新
              </Button>
            )}
            {!available ? (
              <Text style={s.small}>原本を削除したため、共有・書き出しは停止しています。</Text>
            ) : (
              <>
                <Button
                  icon="share-2"
                  disabled={!!busy}
                  onPress={() =>
                    void run('共有リンクを作成中…', async () => {
                      const result = await shareProof(id, days);
                      if (!mounted.current) return;
                      setLink({ id, ...result });
                      await load();
                      await Share.share({
                        title: 'JustTaken 撮影証明',
                        message: '撮影記録と原本の一致を確認できます。\n' + result.url,
                      });
                    })
                  }
                >
                  証明の共有リンクを作成
                </Button>
                {link?.id === id && (
                  <>
                    <Text selectable style={s.small}>
                      {link.url}
                    </Text>
                    <Text style={s.small}>
                      期限：{new Date(link.expiresAt).toLocaleString('ja-JP')}
                    </Text>
                    <Button
                      secondary
                      disabled={!!busy}
                      onPress={() =>
                        void run('共有画面を開きます…', async () => {
                          await Share.share({ message: link.url });
                        })
                      }
                    >
                      このリンクを共有する
                    </Button>
                  </>
                )}
                <Button
                  secondary
                  icon="file-text"
                  disabled={!!busy}
                  onPress={() =>
                    void run('証明ファイルを書き出し中…', () => exportProofFile(proof))
                  }
                >
                  署名付き証明を書き出す
                </Button>
                {Platform.OS !== 'web' && (
                  <Button
                    secondary
                    icon="download"
                    disabled={!!busy}
                    onPress={() =>
                      void run('原本を受信中… 大きなファイルは時間がかかります', () =>
                        exportProofFile(proof, true),
                      )
                    }
                  >
                    原本を元の形式で書き出す
                  </Button>
                )}
                <Text style={s.small}>
                  原本を送る際は、共有先の圧縮・変換を避けるため「ファイル」として送信してください。
                </Text>
              </>
            )}
            <Text style={s.small}>有効な共有リンク：{available ? activeShares : 0}件</Text>
            <Button
              secondary
              disabled={!!busy || (!activeShares && link?.id !== id)}
              onPress={() =>
                void run('共有を停止中…', async () => {
                  await revokeProofShares(id);
                  if (link?.id === id) setLink(null);
                  await load();
                  setNotice(
                    'この証明の共有リンクをすべて停止しました。保存済みのファイルは削除できません。',
                  );
                })
              }
            >
              この証明の共有リンクをすべて停止
            </Button>
            {available &&
              (deleting === id ? (
                <>
                  <Text style={{ color: c.red }}>
                    原本と関連する投稿を削除し、オンラインでの証明の共有を停止します。既に受け渡したコピーは削除できません。
                  </Text>
                  <Button
                    secondary
                    disabled={!!busy}
                    onPress={() =>
                      void run('原本を削除し、共有を停止中…', async () => {
                        await deleteProof(id);
                        setDeleting(null);
                        setLink(null);
                        await load();
                      })
                    }
                  >
                    原本・関連投稿を削除して共有を停止
                  </Button>
                  <Button secondary disabled={!!busy} onPress={() => setDeleting(null)}>
                    戻る
                  </Button>
                </>
              ) : (
                <Button secondary disabled={!!busy} onPress={() => setDeleting(id)}>
                  削除の操作を開く
                </Button>
              ))}
          </View>
        );
      })}
      {cursor && (
        <Button
          secondary
          disabled={!!busy}
          onPress={() => void run('読み込み中…', () => load(cursor))}
        >
          さらに読み込む
        </Button>
      )}
      <Text style={s.small}>
        証明は撮影に使ったアカウントとファイルの整合性を示します。実名本人確認、著作権、被写体の真実性は保証しません。共有を停止しても、保存済みの証明の署名自体は残ります。
      </Text>
    </ScrollView>
  );
}
