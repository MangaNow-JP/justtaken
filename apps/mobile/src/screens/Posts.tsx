import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, Text, View, StyleSheet, RefreshControl, Pressable } from 'react-native';
import { PostInteractions } from '../components/PostInteractions';
import { api, API_URL, accessToken } from '../services/api';
import { type ServerPost } from '../services/capture';
import { Button, EmptyState, Photo, Icon, Avatar } from '../components/UI';
import { OriginalPhoto } from '../components/OriginalPhoto';
import { VideoPreview } from '../components/VideoPreview';
import { useAuth } from '../services/auth';
import { colors as c } from '../theme';
import { PostSafety } from '../components/PostSafety';
export function Posts({
  scope = 'recommended',
  revision = 0,
  activeView = true,
  onCamera,
  onDiscover,
  onUser = () => {},
  endpoint,
  header,
}: {
  scope?: 'recommended' | 'mine' | 'following';
  revision?: number;
  activeView?: boolean;
  onCamera: () => void;
  onDiscover?: () => void;
  onUser?: (id: string) => void;
  endpoint?: string;
  header?: ReactNode;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!activeView) setPlaying(null);
  }, [activeView]);
  const [posts, setPosts] = useState<ServerPost[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [cursor, setCursor] = useState<string | null>(null);
  async function load(more = false) {
    const request = ++generation.current;
    setPlaying(null);
    setBusy(true);
    setError('');
    try {
      const base = endpoint ?? `/v1/feed?scope=${scope}`;
      const data = await api<{
        scope?: string;
        posts?: ServerPost[];
        post?: ServerPost;
        nextCursor: string | null;
      }>(
        base +
          (more && cursor
            ? (base.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor)
            : ''),
      );
      if (generation.current !== request) return;
      // Earlier API versions treated unknown feed scopes as the mixed-visibility feed.
      if (!endpoint && scope === 'recommended' && data.scope !== 'recommended')
        throw new Error('おすすめの投稿をまだ取得できません。');
      const result = {
        posts: data.posts ?? (data.post ? [data.post] : []),
        nextCursor: data.nextCursor ?? null,
      };
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
      if (request === generation.current) {
        setPosts([]);
        setError(e instanceof Error ? e.message : '投稿を読み込めませんでした。');
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setPosts([]);
    setCursor(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [scope, revision, endpoint]);
  return (
    <ScrollView
      onScrollBeginDrag={() => setPlaying(null)}
      contentContainerStyle={{ padding: 20, gap: 20 }}
      refreshControl={
        <RefreshControl refreshing={busy} onRefresh={() => void load()} tintColor={c.ink} />
      }
    >
      {header}
      {!endpoint && (
        <View style={s.heading}>
          <Text style={s.title}>{scope === 'mine' ? 'あなたの投稿' : 'ホーム'}</Text>
          <Icon name="shield" size={18} />
        </View>
      )}
      {!!error && (
        <View style={s.notice}>
          <Text style={s.small}>{error}</Text>
          <Button secondary onPress={() => void load()}>
            再読み込み
          </Button>
        </View>
      )}
      {!posts.length &&
        !busy &&
        !error &&
        (onDiscover ? (
          <>
            <EmptyState icon="users" title="表示できる投稿はまだありません">
              {scope === 'following'
                ? 'フォロー中の人が投稿すると、ここに表示されます。'
                : 'まだフォローしていない人の新しい公開投稿が、ここに表示されます。'}
            </EmptyState>
            <Button secondary icon="search" onPress={onDiscover}>
              ユーザーを探す
            </Button>
          </>
        ) : (
          <>
            <EmptyState
              icon="camera"
              title={endpoint ? '表示できる投稿はありません' : '最初の瞬間を、残そう。'}
            >
              {endpoint
                ? '公開範囲やフォローの状態によって表示される投稿が変わります。'
                : '投稿した写真・動画はここに表示されます。'}
            </EmptyState>
            <Button icon="camera" onPress={onCamera}>
              写真・動画を撮る
            </Button>
          </>
        ))}
      {posts.map((post) => (
        <PostCard
          key={post.post_id}
          post={post}
          onChange={() => void load()}
          active={playing === post.post_id}
          onPlay={() => setPlaying(post.post_id)}
          onStop={() => setPlaying(null)}
          onUser={onUser}
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
  onUser,
}: {
  post: ServerPost;
  onChange: () => void;
  active: boolean;
  onPlay: () => void;
  onStop: () => void;
  onUser: (id: string) => void;
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${post.display_name}のプロフィール`}
        onPress={() => onUser(post.author_id)}
        style={s.author}
      >
        <Avatar initial={post.display_name.slice(0, 1)} />
        <View>
          <Text style={s.name}>{post.display_name}</Text>
          <Text style={s.small}>{new Date(post.created_at).toLocaleString('ja-JP')}</Text>
        </View>
      </Pressable>
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
      <PostInteractions post={post} onUser={onUser} />
      {post.state !== 'PUBLISHED' && (
        <View style={s.notice}>
          <Text style={s.small}>
            {post.moderation === 'BLOCKED'
              ? '内容の確認により、この投稿の公開を停止しました。お問い合わせは設定のリンクからご連絡ください。'
              : '投稿を受け付けました。内容の確認が終わるまで、この投稿はあなただけに表示されます。'}
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
      {profile?.userId !== post.author_id && (
        <PostSafety postId={post.post_id} authorId={post.author_id} onChange={onChange} />
      )}
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
