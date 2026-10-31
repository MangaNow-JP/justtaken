import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { api } from '../services/api';
import { Button } from './UI';
import { colors as c } from '../theme';

const reasons = [
  ['sexual', '性的な内容'],
  ['violence', '暴力・危険な内容'],
  ['harassment', '嫌がらせ'],
  ['privacy', 'プライバシー・権利侵害'],
  ['illegal', '詐欺・違法な内容'],
  ['child_safety', '子どもの安全'],
  ['spam', 'スパム'],
  ['other', 'その他'],
] as const;
export function PostSafety({
  postId,
  commentId,
  authorId,
  onChange,
}: {
  postId?: string;
  commentId?: string;
  authorId: string;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [details, setDetails] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [block, setBlock] = useState(false);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '送信できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <Button secondary onPress={() => setOpen(!open)}>
        通報・ブロック
      </Button>
      {open && (
        <>
          <Text style={{ color: c.ink, lineHeight: 22 }}>
            通報者の情報は投稿者に通知されません。運営が内容を確認し、対応します。
          </Text>
          {reasons.map(([value, label]) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: reason === value }}
              onPress={() => setReason(value)}
              style={{
                padding: 12,
                borderRadius: 10,
                backgroundColor: reason === value ? c.lime : '#EDF1E8',
              }}
            >
              <Text style={{ color: c.ink }}>{label}</Text>
            </Pressable>
          ))}
          <TextInput
            accessibilityLabel="通報の詳細（任意）"
            placeholder="詳細（任意・1,000文字まで）"
            multiline
            maxLength={1000}
            value={details}
            onChangeText={setDetails}
            style={{
              minHeight: 90,
              padding: 12,
              borderWidth: 1,
              borderColor: c.muted,
              borderRadius: 12,
              color: c.ink,
            }}
          />
          <Button
            disabled={busy || !reason}
            onPress={() =>
              void act(async () => {
                if (postId) await api(`/v1/posts/${postId}/reports`, { reason, details });
                else
                  await api('/v1/reports', {
                    userId: authorId,
                    ...(commentId ? { commentId } : {}),
                    reason,
                    details,
                  });
                setMessage('通報を受け付けました。ご協力ありがとうございます。');
              })
            }
          >
            通報を送信
          </Button>
          {block && (
            <Text style={{ color: c.ink, lineHeight: 22 }}>
              この投稿者をブロックしますか？お互いの投稿が表示されなくなり、フォロー関係も解除されます。
            </Text>
          )}
          <Button
            secondary
            disabled={busy}
            onPress={() => {
              if (!block) {
                setBlock(true);
                return;
              }
              void act(async () => {
                await api(`/v1/blocks/${authorId}`, {});
                onChange();
              });
            }}
          >
            {block ? 'ブロックする' : 'この投稿者をブロック'}
          </Button>
          <Button
            secondary
            disabled={busy}
            onPress={() => {
              setOpen(false);
              setBlock(false);
            }}
          >
            閉じる
          </Button>
        </>
      )}
      {!!message && (
        <Text accessibilityRole="alert" style={{ color: c.ink, lineHeight: 22 }}>
          {message}
        </Text>
      )}
    </View>
  );
}
