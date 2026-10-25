import { useEffect, useState } from 'react';
import { ScrollView, Text, View, StyleSheet, RefreshControl } from 'react-native';
import { api, API_URL, accessToken } from '../services/api';
import { type ServerPost } from '../services/capture';
import { Button, EmptyState, Photo, Icon, Avatar } from '../components/UI';
import { OriginalPhoto } from '../components/OriginalPhoto';
import { VideoPreview } from '../components/VideoPreview';
import { useAuth } from '../services/auth';
import { colors as c } from '../theme';
export function Posts({
  scope = 'feed',
  revision = 0,
  activeView = true,
  onCamera,
}: {
  scope?: 'feed' | 'mine';
  revision?: number;
  activeView?: boolean;
  onCamera: () => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => {
    if (!activeView) setPlaying(null);
  }, [activeView]);
  const [posts, setPosts] = useState<ServerPost[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [cursor, setCursor] = useState<string | null>(null);
  async function load(more = false) {
    setPlaying(null);
    setBusy(true);
    setError('');
    try {
      const result = await api<{ posts: ServerPost[]; nextCursor: string | null }>(
        `/v1/feed?scope=${scope}${more && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      );
      setPosts((current) =>
        more
          ? [
              ...current,
              ...result.posts.filter((p) => !current.some((x) => x.post_id === p.post_id)),
            ]
          : result.posts,
      );
      setCursor(result.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : '投稿を読み込めませんでした。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [scope, revision]);
  return (
    <ScrollView
      onScrollBeginDrag={() => setPlaying(null)}
      contentContainerStyle={{ padding: 20, gap: 20 }}
      refreshControl={
        <RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={c.ink} />
      }
    >
      <View style={s.heading}>
        <Text style={s.title}>{scope === 'mine' ? 'あなたの投稿' : 'フォロー中'}</Text>
        <Icon name="shield" size={18} />
      </View>
      {!!error && (
        <View style={s.notice}>
          <Text style={s.small}>{error}</Text>
          <Button secondary onPress={() => void load()}>
            再読み込み
          </Button>
        </View>
      )}
      {!posts.length && !busy && !error && (
        <>
          <EmptyState icon="camera" title="最初の瞬間を、残そう。">
            投稿した写真・動画はここに表示されます。
          </EmptyState>
          <Button icon="camera" onPress={onCamera}>
            写真・動画を撮る
          </Button>
        </>
      )}
      {posts.map((post) => (
        <PostCard
          key={post.post_id}
          post={post}
          onChange={() => void load()}
          active={playing === post.post_id}
          onPlay={() => setPlaying(post.post_id)}
          onStop={() => setPlaying(null)}
        />
      ))}
      {!!cursor && (
        <Button secondary disabled={busy} onPress={() => void load(true)}>
          もっと見る
        </Button>
      )}
    </ScrollView>
  );
}
function PostCard({
  post,
  onChange,
  active,
  onPlay,
  onStop,
}: {
  post: ServerPost;
  onChange: () => void;
  active: boolean;
  onPlay: () => void;
  onStop: () => void;
}) {
  const { profile } = useAuth();
  const [originalFormat, setOriginalFormat] = useState<{
    mime: string;
    hasGainMap: boolean;
    preservation: string | null;
  } | null>(null);
  const [kind, setKind] = useState<'photo' | 'video'>('photo');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(
      null,
    ),
    [error, setError] = useState(''),
    [record, setRecord] = useState<any>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const grant = await api<{
          original: string;
          preview: string;
          kind: 'photo' | 'video';
          originalFormat: { mime: string; hasGainMap: boolean; preservation: string | null };
        }>(`/v1/posts/${post.post_id}/media-grants`, {});
        const token = await accessToken();
        if (alive) {
          setKind(grant.kind);
          setOriginalFormat(grant.originalFormat);
          setSource({
            uri: API_URL + grant.preview,
            headers: { Authorization: 'Bearer ' + token },
          });
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : '写真を確認しています。');
      }
    })();
    return () => {
      alive = false;
    };
  }, [post.post_id, post.state]);
  async function showRecord() {
    setBusy(true);
    try {
      setRecord(await api(`/v1/posts/${post.post_id}/record`));
    } catch (e) {
      setError(e instanceof Error ? e.message : '撮影記録を読み込めませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={s.card}>
      <View style={s.author}>
        <Avatar initial={post.display_name.slice(0, 1)} />
        <View>
          <Text style={s.name}>{post.display_name}</Text>
          <Text style={s.small}>{new Date(post.created_at).toLocaleString('ja-JP')}</Text>
        </View>
      </View>
      {source ? (
        kind === 'video' ? (
          <VideoPreview
            poster={source}
            active={active}
            onPlay={onPlay}
            onStop={onStop}
            style={{ height: 380, borderRadius: 16, overflow: 'hidden' }}
            load={async () => {
              const grant = await api<{ original: string }>(
                `/v1/posts/${post.post_id}/media-grants`,
                {},
              );
              return {
                uri: API_URL + grant.original,
                headers: { Authorization: 'Bearer ' + (await accessToken()) },
                useCaching: false,
              };
            }}
          />
        ) : (
          <OriginalPhoto
            preview={source}
            style={{ aspectRatio: 1, borderRadius: 16 }}
            active={active}
            onOpen={onPlay}
            onClose={onStop}
            load={async () => {
              const grant = await api<{ original: string }>(
                `/v1/posts/${post.post_id}/media-grants`,
                {},
              );
              return {
                uri: API_URL + grant.original,
                headers: { Authorization: 'Bearer ' + (await accessToken()) },
              };
            }}
          />
        )
      ) : (
        <View style={s.placeholder}>
          <Icon name="image" color={c.muted} />
          <Text style={s.small}>{error || 'メディアを読み込み中…'}</Text>
        </View>
      )}
      {kind === 'photo' && originalFormat && (
        <Text style={s.small}>
          {originalFormat.mime === 'image/heic'
            ? 'HEIF'
            : originalFormat.mime === 'image/x-adobe-dng'
              ? 'RAW (DNG)'
              : 'JPEG'}
          {originalFormat.hasGainMap ? ' · HDRゲインマップあり' : ''}
          {originalFormat.preservation === 'camera-original' ? ' · 原本を保持' : ''}
        </Text>
      )}
      <Text style={s.caption}>{post.caption || 'いま撮った、その瞬間を。'}</Text>
      {post.state !== 'PUBLISHED' && (
        <View style={s.notice}>
          <Text style={s.small}>
            投稿を受け付けました。内容の確認が終わるまで、この投稿はあなただけに表示されます。
          </Text>
          <Button
            disabled={busy}
            secondary
            onPress={async () => {
              setBusy(true);
              try {
                await api(`/v1/posts/${post.post_id}/publish`, {});
                onChange();
              } catch (e) {
                setError(e instanceof Error ? e.message : '更新できませんでした。');
              } finally {
                setBusy(false);
              }
            }}
          >
            確認状況を更新
          </Button>
        </View>
      )}
      <Button secondary icon="shield" disabled={busy} onPress={() => void showRecord()}>
        撮影記録を見る
      </Button>
      {profile?.userId === post.author_id && (
        <View style={{ gap: 10 }}>
          {confirmDelete ? (
            <>
              <Text style={s.small}>
                この投稿を削除しますか？撮影証明として保存済みの原本は残ります。原本の削除は「あなたの撮影証明」で行えます。証明を保存していない以前の投稿は、撮影データも削除されます。
              </Text>
              <Button
                disabled={busy}
                onPress={async () => {
                  setBusy(true);
                  try {
                    await api('/v1/posts/' + post.post_id, undefined, 'DELETE');
                    onChange();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : '削除できませんでした。');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                削除する
              </Button>
              <Button secondary onPress={() => setConfirmDelete(false)}>
                キャンセル
              </Button>
            </>
          ) : (
            <Button secondary icon="trash-2" onPress={() => setConfirmDelete(true)}>
              投稿を削除
            </Button>
          )}
        </View>
      )}
      {!!error && !!source && (
        <Text accessibilityRole="alert" style={s.small}>
          {error}
        </Text>
      )}
      {!!record && (
        <View style={s.notice}>
          <Text style={s.name}>撮影記録を確認</Text>
          <Text style={s.small}>
            撮影日時（端末） {new Date(record.manifest.clientCapturedAt).toLocaleString('ja-JP')}
          </Text>
          <Text style={s.small}>
            確認日時 {new Date(record.verifiedAt).toLocaleString('ja-JP')}
          </Text>
          <Text style={s.small}>{record.notice}</Text>
        </View>
      )}
    </View>
  );
}
const s = StyleSheet.create({
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 21, fontWeight: '700', color: c.ink },
  card: { gap: 15, paddingBottom: 24, borderBottomWidth: 1, borderColor: c.line },
  author: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  name: { fontSize: 14, fontWeight: '600', color: c.ink },
  small: { fontSize: 12, color: c.muted, lineHeight: 21 },
  caption: { fontSize: 15, color: c.ink, lineHeight: 25 },
  notice: { padding: 14, backgroundColor: c.pale, borderRadius: 14, gap: 10 },
  placeholder: {
    aspectRatio: 1,
    backgroundColor: c.pale,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 10,
  },
});
