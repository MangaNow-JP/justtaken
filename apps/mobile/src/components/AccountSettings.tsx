import { useEffect, useState } from 'react';
import { Linking, Text, TextInput, View, Switch } from 'react-native';
import { useAuth } from '../services/auth';
import { api, APIError, currentCredentials, saveCredentials, type Profile } from '../services/api';
import {
  deleteAccount,
  refreshDeletion,
  pendingDeletion,
  forgetDeletionReceipt,
  type DeletionStatus,
} from '../services/account';
import { Button } from './UI';
import { colors as c } from '../theme';

export function AccountSettings({
  onDeleted,
  onModeration,
}: {
  onDeleted: () => void;
  onModeration: () => void;
}) {
  const { profile } = useAuth();
  const [name, setName] = useState(profile?.displayName ?? ''),
    [privateAccount, setPrivate] = useState(profile?.isPrivate ?? true);
  const [confirm, setConfirm] = useState(false),
    [confirmation, setConfirmation] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [status, setStatus] = useState<DeletionStatus | null>(null),
    [receipt, setReceipt] = useState(false),
    [blocks, setBlocks] = useState<{ userId: string; displayName: string }[] | null>(null);
  useEffect(() => {
    void pendingDeletion()
      .then((v) => setReceipt(!!v))
      .catch(() => {});
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      {!!profile && (
        <>
          <Text style={{ color: c.ink, fontWeight: '700' }}>プロフィール</Text>
          <TextInput
            accessibilityLabel="表示名"
            value={name}
            onChangeText={setName}
            maxLength={60}
            style={{
              padding: 12,
              borderWidth: 1,
              borderColor: c.muted,
              borderRadius: 12,
              color: c.ink,
            }}
          />
          <View
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Text style={{ color: c.ink }}>非公開アカウント</Text>
            <Switch
              accessibilityLabel="非公開アカウント"
              value={privateAccount}
              onValueChange={setPrivate}
            />
          </View>
          <Text style={{ color: c.muted, lineHeight: 22 }}>
            OFFにすると投稿時に全体公開を選べます。ONに戻すと、過去の全体公開投稿も自分のみに変更します。
          </Text>
          <Button
            secondary
            disabled={busy}
            onPress={() =>
              void run(async () => {
                await api('/v1/me', { displayName: name, isPrivate: privateAccount });
                const me = await api<{ profile: Profile }>('/v1/me'),
                  saved = currentCredentials();
                if (saved) await saveCredentials({ ...saved, profile: me.profile });
                setMessage('プロフィールを保存しました。');
              })
            }
          >
            プロフィールを保存
          </Button>
          <Button
            secondary
            disabled={busy}
            onPress={() =>
              void run(async () => {
                const result = await api<{ blocks: { userId: string; displayName: string }[] }>(
                  '/v1/blocks',
                );
                setBlocks(result.blocks);
              })
            }
          >
            ブロックしたアカウント
          </Button>
          {blocks?.length === 0 && (
            <Text style={{ color: c.muted }}>ブロック中のアカウントはありません。</Text>
          )}
          {blocks?.map((b) => (
            <View key={b.userId} style={{ gap: 8 }}>
              <Text style={{ color: c.ink }}>{b.displayName}</Text>
              <Button
                secondary
                disabled={busy}
                onPress={() =>
                  void run(async () => {
                    await api(`/v1/blocks/${b.userId}`, undefined, 'DELETE');
                    setBlocks((v) => v!.filter((x) => x.userId !== b.userId));
                  })
                }
              >
                ブロック解除
              </Button>
            </View>
          ))}
          {profile.moderator && (
            <Button secondary onPress={onModeration}>
              運営の確認待ち投稿・通報
            </Button>
          )}
          <Button secondary disabled={busy} onPress={() => setConfirm(!confirm)}>
            アカウントを削除
          </Button>
          {confirm && (
            <>
              <Text style={{ color: c.ink, lineHeight: 24 }}>
                アカウント、投稿、非公開の原本、撮影証明、端末の下書きを削除します。共有リンクとログインは直ちに無効になります。削除は取り消せません。
              </Text>
              <Text style={{ color: c.muted, lineHeight: 22 }}>
                通常は25時間以内に削除と再確認を完了します。通信障害時は自動再試行します。復活防止のため同じログイン方法での再登録は31日間制限されます。バックアップは最大30日で失効します。第三者が保存したファイルや、独立監査ログのハッシュは消去できません。
              </Text>
              <Text style={{ color: c.ink }}>確認のため「削除」と入力してください。</Text>
              <TextInput
                accessibilityLabel="削除の確認"
                value={confirmation}
                onChangeText={setConfirmation}
                editable={!busy}
                style={{
                  padding: 12,
                  borderWidth: 1,
                  borderColor: c.muted,
                  borderRadius: 12,
                  color: c.ink,
                }}
              />
              <Button
                disabled={busy || confirmation !== '削除'}
                onPress={() =>
                  void run(async () => {
                    const result = await deleteAccount(profile.userId);
                    setStatus(result);
                    setReceipt(true);
                    setConfirm(false);
                    onDeleted();
                  })
                }
              >
                {busy ? '受付を確認しています…' : 'アカウントとデータを削除する'}
              </Button>
              <Button
                secondary
                disabled={busy}
                onPress={() => {
                  setConfirm(false);
                  setConfirmation('');
                }}
              >
                キャンセル
              </Button>
            </>
          )}
        </>
      )}
      {receipt && (
        <>
          <Text style={{ color: c.ink, lineHeight: 24 }}>
            {status?.status === 'COMPLETE'
              ? 'アカウントとデータの削除が完了しました。'
              : status
                ? '削除を受け付けました。処理はアプリを閉じても継続します。'
                : '保存された削除受付の状況を確認できます。'}
          </Text>
          <Button
            secondary
            disabled={busy}
            onPress={() =>
              void run(async () => {
                try {
                  const result = await refreshDeletion();
                  setStatus(result);
                  if (result && !currentCredentials()) onDeleted();
                } catch (e) {
                  if (e instanceof APIError && e.status === 404) {
                    setMessage(
                      '受付記録が見つかりません。未受付の場合は再度削除をお試しください。完了から30日経過した受付記録は消去されます。',
                    );
                  } else throw e;
                }
              })
            }
          >
            削除の進み具合を確認
          </Button>
          {status?.provider_revocation === 'MANUAL_REQUIRED' && (
            <>
              <Text style={{ color: c.muted, lineHeight: 22 }}>
                以前のログイン連携情報が保存されていなかった場合、利用した認証サービス側でもJustTakenの連携を解除してください。
              </Text>
              <Button secondary onPress={() => void Linking.openURL('https://account.apple.com/')}>
                Appleの連携設定
              </Button>
              <Button
                secondary
                onPress={() => void Linking.openURL('https://myaccount.google.com/connections')}
              >
                Googleの連携設定
              </Button>
            </>
          )}
          {status?.status === 'COMPLETE' && (
            <Button
              secondary
              onPress={() =>
                void run(async () => {
                  await forgetDeletionReceipt();
                  setReceipt(false);
                })
              }
            >
              完了メッセージを閉じる
            </Button>
          )}
        </>
      )}
      {!!message && (
        <Text accessibilityRole="alert" style={{ color: c.red, lineHeight: 22 }}>
          {message}
        </Text>
      )}
    </View>
  );
}
