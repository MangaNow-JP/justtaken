import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from '../services/api';
import { useAuth } from '../services/auth';
import { Avatar, Button, EmptyState, Icon, IconButton } from '../components/UI';
import { PostSafety } from '../components/PostSafety';
import { Posts } from './Posts';
import { colors as c } from '../theme';

type User = {
  userId: string;
  displayName: string;
  isPrivate: boolean | number;
  relationship: 'REMOVED' | 'PENDING' | 'APPROVED';
  followers?: number;
  following?: number;
  posts?: number;
};
type Notification = {
  notification_id: string;
  actor_id: string;
  display_name: string;
  kind: 'follow' | 'request' | 'accepted' | 'like' | 'comment';
  post_id: string | null;
  created_at: string;
  read_at: string | null;
};
export type SocialRoute =
  | { kind: 'search' | 'inbox' | 'requests' | 'saved' }
  | { kind: 'profile'; userId: string }
  | { kind: 'people'; userId: string; list: 'followers' | 'following' }
  | { kind: 'post'; postId: string };
const descriptions = {
  follow: 'あなたをフォローしました',
  request: 'フォロー申請が届きました',
  accepted: 'フォロー申請が承認されました',
  like: 'あなたの投稿にいいねしました',
  comment: 'あなたの投稿にコメントしました',
};
export function useUnreadNotifications(userId?: string) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true,
      working = false;
    setUnread(0);
    async function refresh() {
      if (!userId || working || AppState.currentState === 'background') return;
      working = true;
      try {
        const data = await api<{ unread: number }>('/v1/notifications');
        if (alive) setUnread(data.unread);
      } catch {
      } finally {
        working = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      listener.remove();
    };
  }, [userId]);
  return { unread, setUnread };
}
export function Social({
  initial,
  onCamera,
  onRead,
}: {
  initial: SocialRoute;
  onCamera: () => void;
  onRead?: (unread: number) => void;
}) {
  const { profile: me } = useAuth();
  const [routes, setRoutes] = useState<SocialRoute[]>([initial]);
  const route = routes[routes.length - 1];
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const [users, setUsers] = useState<User[]>([]),
    [notifications, setNotifications] = useState<Notification[]>([]),
    [profile, setProfile] = useState<User | null>(null);
  const [query, setQuery] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [mutating, setMutating] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const navigate = (next: SocialRoute) => setRoutes((stack) => [...stack, next]);
  const openUser = (userId: string) => navigate({ kind: 'profile', userId });
  async function load(more = false) {
    const g = ++generation.current;
    if (!me) return;
    if (route.kind === 'post' || route.kind === 'saved') {
      setBusy(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      let endpoint = '';
      if (route.kind === 'search') endpoint = '/v1/users?q=' + encodeURIComponent(query.trim());
      if (route.kind === 'inbox') endpoint = '/v1/notifications';
      if (route.kind === 'requests') endpoint = '/v1/follow-requests';
      if (route.kind === 'profile') endpoint = `/v1/users/${route.userId}`;
      if (route.kind === 'people') endpoint = `/v1/users/${route.userId}/${route.list}`;
      if (more && cursor)
        endpoint +=
          (endpoint.includes('?') ? '&' : '?') +
          (route.kind === 'search' ? 'after' : 'cursor') +
          '=' +
          encodeURIComponent(cursor);
      const data = await api<{
        users?: User[];
        items?: any[];
        profile?: User;
        nextCursor?: string | null;
        unread?: number;
      }>(endpoint);
      if (g !== generation.current) return;
      if (route.kind === 'profile') setProfile(data.profile!);
      else if (route.kind === 'inbox') {
        const items = data.items as Notification[];
        setNotifications((prev) =>
          more
            ? [
                ...prev,
                ...items.filter((n) => !prev.some((p) => p.notification_id === n.notification_id)),
              ]
            : items,
        );
        const ids = items.filter((n) => !n.read_at).map((n) => n.notification_id);
        if (ids.length) {
          await api('/v1/notifications/read', { ids });
          if (g === generation.current) onRead?.(Math.max(0, (data.unread ?? 0) - ids.length));
        }
      } else {
        const items = data.users ?? (data.items as User[]);
        setUsers((prev) =>
          more
            ? [...prev, ...items.filter((u) => !prev.some((p) => p.userId === u.userId))]
            : items,
        );
      }
      if (g === generation.current) setCursor(data.nextCursor ?? null);
    } catch (e) {
      if (g === generation.current) {
        setUsers([]);
        setNotifications([]);
        setProfile(null);
        setError(e instanceof Error ? e.message : '読み込めませんでした。');
      }
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setUsers([]);
    setNotifications([]);
    setProfile(null);
    setCursor(null);
    setError('');
    const timer = setTimeout(() => void load(), route.kind === 'search' ? 300 : 0);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [route, query, me?.userId]);
  async function mutate(fn: () => Promise<unknown>) {
    if (mutating) return;
    setMutating(true);
    setError('');
    try {
      await fn();
      if (currentRoute.current !== route) return;
      await load();
      setRevision((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新できませんでした。');
    } finally {
      setMutating(false);
    }
  }
  const title =
    route.kind === 'search'
      ? 'ユーザーを探す'
      : route.kind === 'inbox'
        ? 'お知らせ'
        : route.kind === 'requests'
          ? 'フォロー申請'
          : route.kind === 'people'
            ? route.list === 'followers'
              ? 'フォロワー'
              : 'フォロー中'
            : route.kind === 'saved'
              ? '保存した投稿'
              : route.kind === 'post'
                ? '投稿'
                : 'プロフィール';
  const profileHeader = profile && (
    <View style={{ gap: 16, paddingBottom: 12 }}>
      <Avatar initial={profile.displayName.slice(0, 1)} size={72} />
      <Text style={{ color: c.ink, fontSize: 24, fontWeight: '700' }}>{profile.displayName}</Text>
      <Text style={{ color: c.muted }}>
        {profile.isPrivate ? '非公開アカウント' : '公開アカウント'}
      </Text>
      <View style={{ flexDirection: 'row', gap: 24 }}>
        <Text style={{ color: c.ink, paddingVertical: 12 }}>{profile.posts ?? 0} 投稿</Text>
        {(['followers', 'following'] as const).map((list) => (
          <Pressable
            key={list}
            accessibilityRole="button"
            onPress={() => navigate({ kind: 'people', userId: profile.userId, list })}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={{ color: c.ink }}>
              {profile[list] ?? 0} {list === 'followers' ? 'フォロワー' : 'フォロー中'}
            </Text>
          </Pressable>
        ))}
      </View>
      {profile.userId !== me?.userId ? (
        <>
          <Button
            secondary={profile.relationship !== 'REMOVED'}
            disabled={mutating}
            onPress={() =>
              void mutate(() =>
                api(
                  `/v1/users/${profile.userId}/follow`,
                  undefined,
                  profile.relationship === 'REMOVED' ? 'PUT' : 'DELETE',
                ),
              )
            }
          >
            {profile.relationship === 'PENDING'
              ? '申請中 · 取り消す'
              : profile.relationship === 'APPROVED'
                ? 'フォロー中 · 解除する'
                : profile.isPrivate
                  ? 'フォローを申請'
                  : 'フォローする'}
          </Button>
          {profile.isPrivate && profile.relationship !== 'APPROVED' && (
            <Text style={{ color: c.muted, lineHeight: 22 }}>
              承認されると、共有された投稿を見られます。
            </Text>
          )}
          <PostSafety authorId={profile.userId} onChange={() => void load()} />
        </>
      ) : (
        <>
          <Button secondary icon="user-plus" onPress={() => navigate({ kind: 'requests' })}>
            フォロー申請を確認
          </Button>
          <Button secondary icon="bookmark" onPress={() => navigate({ kind: 'saved' })}>
            保存した投稿
          </Button>
        </>
      )}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {routes.length > 1 && (
          <IconButton
            name="arrow-left"
            label="戻る"
            onPress={() => setRoutes((stack) => stack.slice(0, -1))}
          />
        )}
        <Text style={{ color: c.ink, fontSize: 22, fontWeight: '700', flex: 1 }}>{title}</Text>
        {route.kind === 'inbox' && (
          <IconButton
            name="user-plus"
            label="フォロー申請"
            onPress={() => navigate({ kind: 'requests' })}
          />
        )}
      </View>
      {!me ? (
        <EmptyState icon="user" title="ログインしてつながろう">
          ホームからログインすると利用できます。
        </EmptyState>
      ) : (
        <>
          {!!error && (
            <View style={{ padding: 20, gap: 12 }}>
              <Text accessibilityRole="alert" style={{ color: c.red }}>
                {error}
              </Text>
              <Button secondary onPress={() => void load()}>
                再読み込み
              </Button>
            </View>
          )}
          {route.kind === 'profile' && profile ? (
            <Posts
              key={profile.userId}
              header={profileHeader}
              revision={revision}
              endpoint={`/v1/users/${profile.userId}/posts`}
              onUser={openUser}
              onCamera={onCamera}
            />
          ) : route.kind === 'post' ? (
            <Posts
              key={route.postId}
              endpoint={`/v1/posts/${route.postId}`}
              onUser={openUser}
              onCamera={onCamera}
            />
          ) : route.kind === 'saved' ? (
            <Posts endpoint="/v1/saved-posts" onUser={openUser} onCamera={onCamera} />
          ) : (
            <>
              {route.kind === 'search' && (
                <View
                  style={{
                    marginHorizontal: 20,
                    marginBottom: 10,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    backgroundColor: c.white,
                    padding: 14,
                    borderRadius: 16,
                  }}
                >
                  <Icon name="search" />
                  <TextInput
                    accessibilityLabel="表示名でユーザー検索"
                    placeholder="表示名で検索"
                    placeholderTextColor={c.muted}
                    value={query}
                    onChangeText={setQuery}
                    autoCapitalize="none"
                    maxLength={80}
                    style={{ flex: 1, color: c.ink, fontSize: 16 }}
                  />
                </View>
              )}
              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ padding: 20, gap: 16 }}
                refreshControl={
                  <RefreshControl
                    refreshing={busy}
                    onRefresh={() => void load()}
                    tintColor={c.ink}
                  />
                }
              >
                {busy && !users.length && !notifications.length && (
                  <ActivityIndicator color={c.ink} />
                )}
                {route.kind === 'inbox' && (
                  <Text style={{ color: c.muted, lineHeight: 22 }}>
                    フォローや投稿への反応がここに届きます。
                  </Text>
                )}
                {!busy && !error && !users.length && !notifications.length && (
                  <EmptyState
                    icon={route.kind === 'search' ? 'search' : 'inbox'}
                    title={
                      route.kind === 'search'
                        ? query.trim()
                          ? 'ユーザーが見つかりません'
                          : '気になる人を探そう'
                        : 'まだ届いていません'
                    }
                  >
                    {route.kind === 'search'
                      ? '表示名を入力して検索できます。'
                      : '新しいつながりや反応があると表示されます。'}
                  </EmptyState>
                )}
                {users.map((u) => (
                  <View
                    key={u.userId}
                    style={{ padding: 16, borderRadius: 16, backgroundColor: c.white, gap: 12 }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => openUser(u.userId)}
                      style={{ flexDirection: 'row', gap: 12, alignItems: 'center', minHeight: 48 }}
                    >
                      <Avatar initial={u.displayName.slice(0, 1)} />
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={{ color: c.ink, fontWeight: '700' }}>{u.displayName}</Text>
                        <Text style={{ color: c.muted, fontSize: 12 }}>
                          {u.isPrivate ? '非公開' : '公開'}
                          {u.relationship === 'APPROVED'
                            ? ' · フォロー中'
                            : u.relationship === 'PENDING'
                              ? ' · 申請中'
                              : ''}
                        </Text>
                      </View>
                      <Icon name="chevron-right" />
                    </Pressable>
                    {route.kind === 'requests' && (
                      <>
                        <Button
                          disabled={mutating}
                          onPress={() =>
                            void mutate(() =>
                              api(`/v1/follow-requests/${u.userId}`, undefined, 'PUT'),
                            )
                          }
                        >
                          承認する
                        </Button>
                        <Button
                          secondary
                          disabled={mutating}
                          onPress={() =>
                            void mutate(() =>
                              api(`/v1/follow-requests/${u.userId}`, undefined, 'DELETE'),
                            )
                          }
                        >
                          申請を削除
                        </Button>
                      </>
                    )}
                    {route.kind === 'people' &&
                      route.userId === me.userId &&
                      route.list === 'followers' && (
                        <Button
                          secondary
                          disabled={mutating}
                          onPress={() =>
                            void mutate(() => api(`/v1/followers/${u.userId}`, undefined, 'DELETE'))
                          }
                        >
                          フォロワーから削除
                        </Button>
                      )}
                  </View>
                ))}
                {notifications.map((n) => (
                  <Pressable
                    key={n.notification_id}
                    accessibilityRole="button"
                    onPress={() =>
                      n.kind === 'request'
                        ? navigate({ kind: 'requests' })
                        : n.post_id
                          ? navigate({ kind: 'post', postId: n.post_id })
                          : openUser(n.actor_id)
                    }
                    style={{
                      padding: 18,
                      borderRadius: 16,
                      backgroundColor: n.read_at ? c.white : c.pale,
                      flexDirection: 'row',
                      gap: 12,
                    }}
                  >
                    <Avatar initial={n.display_name.slice(0, 1)} />
                    <View style={{ flex: 1, gap: 6 }}>
                      <Text style={{ color: c.ink, lineHeight: 24 }}>
                        <Text style={{ fontWeight: '700' }}>{n.display_name}</Text>
                        {'\n'}
                        {descriptions[n.kind]}
                      </Text>
                      <Text style={{ color: c.muted, fontSize: 12 }}>
                        {new Date(n.created_at).toLocaleString('ja-JP')}
                      </Text>
                    </View>
                  </Pressable>
                ))}
                {!!cursor && (
                  <Button secondary disabled={busy} onPress={() => void load(true)}>
                    もっと見る
                  </Button>
                )}
              </ScrollView>
            </>
          )}
        </>
      )}
    </View>
  );
}
