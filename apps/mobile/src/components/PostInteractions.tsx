import { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { API_URL, api } from '../services/api';
import { canSharePost, postShareUrl } from '@justtaken/contracts/post-share';
import { useAuth } from '../services/auth';
import { type ServerPost } from '../services/capture';
import { colors as c } from '../theme';
import { Button, Icon, IconButton } from './UI';
import { PostSafety } from './PostSafety';
type Comment = {
  comment_id: string;
  user_id: string;
  display_name: string;
  body: string;
  created_at: string;
};
export function PostInteractions({
  post,
  onUser,
}: {
  post: ServerPost;
  onUser: (id: string) => void;
}) {
  const { profile } = useAuth();
  const [social, setSocial] = useState(post),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [open, setOpen] = useState(false),
    [comments, setComments] = useState<Comment[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [text, setText] = useState('');
  const submission = useRef<{ id: string; text: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    setSocial(post);
  }, [post]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  async function load(more = false) {
    const g = ++generation.current;
    const result = await api<{ items: Comment[]; nextCursor: string | null }>(
      `/v1/posts/${post.post_id}/comments${more && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`,
    );
    if (g !== generation.current) return;
    setComments((prev) =>
      more
        ? [...prev, ...result.items.filter((x) => !prev.some((p) => p.comment_id === x.comment_id))]
        : result.items,
    );
    setCursor(result.nextCursor);
  }
  async function sync() {
    const result = await api<{ social: ServerPost }>(`/v1/posts/${post.post_id}/social`);
    setSocial((s) => ({ ...s, ...result.social }));
  }
  const toggle = (kind: 'like' | 'save', selected: boolean) =>
    void act(async () => {
      const result = await api<{ social: ServerPost }>(
        `/v1/posts/${post.post_id}/${kind}`,
        undefined,
        selected ? 'DELETE' : 'PUT',
      );
      setSocial((s) => ({ ...s, ...result.social }));
    });
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
        <Pressable
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={social.liked ? 'いいねを取り消す' : 'いいね'}
          accessibilityState={{ selected: !!social.liked, disabled: busy }}
          onPress={() => toggle('like', !!social.liked)}
          style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 6 }}
        >
          <Icon name="heart" color={social.liked ? c.red : c.ink} />
          <Text style={{ color: c.ink }}>{social.like_count ?? 0}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="コメントを開く"
          onPress={() => {
            setOpen(true);
            void act(() => load());
          }}
          style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 6 }}
        >
          <Icon name="message-circle" />
          <Text style={{ color: c.ink }}>{social.comment_count ?? 0}</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        {canSharePost(post) && (
          <IconButton
            name="share-2"
            label="投稿をシェア"
            disabled={busy}
            onPress={() =>
              void act(async () => {
                await Share.share({ message: postShareUrl(post.post_id, API_URL) });
              })
            }
          />
        )}
        <IconButton
          name="bookmark"
          disabled={busy}
          label={social.saved ? '保存を解除' : 'この投稿を保存'}
          color={social.saved ? '#5B8323' : c.muted}
          onPress={() => toggle('save', !!social.saved)}
        />
      </View>
      {!!error && !open && (
        <Text accessibilityRole="alert" style={{ color: c.red }}>
          {error}
        </Text>
      )}
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              padding: 16,
              justifyContent: 'space-between',
            }}
          >
            <Text style={{ color: c.ink, fontSize: 22, fontWeight: '700' }}>コメント</Text>
            <IconButton name="x" label="コメントを閉じる" onPress={() => setOpen(false)} />
          </View>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ padding: 20, gap: 24 }}
            >
              {!comments.length && !busy && (
                <Text style={{ color: c.muted }}>まだコメントはありません。</Text>
              )}
              {comments.map((item) => (
                <View
                  key={item.comment_id}
                  style={{ gap: 10, borderBottomWidth: 1, borderColor: c.line, paddingBottom: 18 }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${item.display_name}のプロフィール`}
                    onPress={() => {
                      setOpen(false);
                      onUser(item.user_id);
                    }}
                    style={{ minHeight: 44, justifyContent: 'center' }}
                  >
                    <Text style={{ color: c.ink, fontWeight: '700' }}>{item.display_name}</Text>
                  </Pressable>
                  <Text selectable style={{ color: c.ink, lineHeight: 24 }}>
                    {item.body}
                  </Text>
                  <Text style={{ color: c.muted, fontSize: 12 }}>
                    {new Date(item.created_at).toLocaleString('ja-JP')}
                  </Text>
                  {(item.user_id === profile?.userId || post.author_id === profile?.userId) && (
                    <Button
                      secondary
                      disabled={busy}
                      onPress={() =>
                        void act(async () => {
                          await api(`/v1/comments/${item.comment_id}`, undefined, 'DELETE');
                          await Promise.all([load(), sync()]);
                        })
                      }
                    >
                      コメントを削除
                    </Button>
                  )}
                  {item.user_id !== profile?.userId && (
                    <PostSafety
                      authorId={item.user_id}
                      commentId={item.comment_id}
                      onChange={() =>
                        void act(async () => {
                          await Promise.all([load(), sync()]);
                        })
                      }
                    />
                  )}
                </View>
              ))}
              {!!cursor && (
                <Button secondary disabled={busy} onPress={() => void act(() => load(true))}>
                  以前のコメント
                </Button>
              )}
            </ScrollView>
            <View style={{ padding: 16, gap: 12, borderTopWidth: 1, borderColor: c.line }}>
              {!!error && (
                <Text accessibilityRole="alert" style={{ color: c.red }}>
                  {error}
                </Text>
              )}
              <TextInput
                value={text}
                onChangeText={setText}
                editable={!busy}
                multiline
                maxLength={2000}
                accessibilityLabel="コメント"
                placeholder="コメントを入力（500文字まで）"
                placeholderTextColor={c.muted}
                style={{
                  color: c.ink,
                  borderWidth: 1,
                  borderColor: c.line,
                  padding: 14,
                  borderRadius: 12,
                  minHeight: 52,
                  maxHeight: 120,
                }}
              />
              <Button
                disabled={busy || !text.trim()}
                onPress={() =>
                  void act(async () => {
                    if (!submission.current || submission.current.text !== text)
                      submission.current = { id: Crypto.randomUUID(), text };
                    await api(`/v1/posts/${post.post_id}/comments`, {
                      commentId: submission.current.id,
                      body: text,
                    });
                    submission.current = null;
                    setText('');
                    await Promise.all([load(), sync()]);
                  })
                }
              >
                {busy ? '処理中…' : 'コメントを送信'}
              </Button>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
