import { useEffect, useState } from 'react';
import { Alert, ScrollView, Text, TextInput, View } from 'react-native';
import { api, API_URL, accessToken } from '../services/api';
import { Button, EmptyState } from '../components/UI';
import { OriginalPhoto } from '../components/OriginalPhoto';
import { VideoPreview } from '../components/VideoPreview';
import { colors as c } from '../theme';
type AccountReport = {
  report_id: string;
  target_user_id: string;
  display_name: string;
  reason: string;
  details: string;
};
type Item = {
  post_id: string;
  caption: string;
  display_name: string;
  revision: number;
  moderation: string;
  reports: { report_id: string; reason: string; details: string }[];
};
export function Moderation() {
  const [accountReports, setAccountReports] = useState<AccountReport[]>([]);
  const [items, setItems] = useState<Item[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load(next = false) {
    setBusy(true);
    setError('');
    try {
      const data = await api<{
        posts: Item[];
        accountReports: AccountReport[];
        nextCursor: string | null;
      }>(`/v1/moderation/queue${next && cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`);
      setItems(data.posts);
      setAccountReports(data.accountReports);
      setCursor(data.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込めませんでした。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
      <Text style={{ color: c.ink, lineHeight: 24 }}>
        公開前の投稿と通報を確認します。原本の内容を確認してから判断してください。通報は24時間以内を目安に確認・対応してください。
      </Text>
      <Button secondary disabled={busy} onPress={() => void load()}>
        一覧を更新
      </Button>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.red }}>
          {error}
        </Text>
      )}
      {!items.length && !accountReports.length && !busy && !error && (
        <EmptyState icon="shield" title="確認待ちはありません">
          新しい投稿・通報が届くとここに表示されます。
        </EmptyState>
      )}
      {accountReports.map((item) => (
        <AccountReview key={item.report_id} item={item} refresh={() => void load()} />
      ))}
      {items.map((item) => (
        <Review key={item.post_id + item.revision} item={item} refresh={() => void load()} />
      ))}
      {cursor && (
        <Button secondary disabled={busy} onPress={() => void load(true)}>
          次のページ
        </Button>
      )}
    </ScrollView>
  );
}
function Review({ item, refresh }: { item: Item; refresh: () => void }) {
  const [note, setNote] = useState(''),
    [view, setView] = useState<'photo' | 'video' | null>(null),
    [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    const source = {
      uri: API_URL + `/v1/moderation/posts/${item.post_id}/media`,
      headers: { Authorization: 'Bearer ' + (await accessToken()) },
    };
    setOpened(true);
    return source;
  };
  return (
    <View style={{ padding: 16, backgroundColor: '#EDF1E8', borderRadius: 16, gap: 12 }}>
      <Text style={{ color: c.ink, fontWeight: '700' }}>{item.display_name}</Text>
      <Text style={{ color: c.ink }}>{item.caption}</Text>
      {item.reports.map((r) => (
        <Text key={r.report_id} style={{ color: c.ink, lineHeight: 22 }}>
          通報理由: {r.reason}
          {'\n'}
          {r.details}
        </Text>
      ))}
      <Button secondary onPress={() => setView('photo')}>
        写真の原本を確認
      </Button>
      <Button secondary onPress={() => setView('video')}>
        動画の原本を確認
      </Button>
      {view === 'photo' && (
        <OriginalPhoto
          preview={require('../../assets/app-icon.png')}
          active
          onOpen={() => {}}
          onClose={() => setView(null)}
          load={load}
          style={{ height: 220 }}
        />
      )}
      {view === 'video' && (
        <VideoPreview
          poster={require('../../assets/app-icon.png')}
          active
          onPlay={() => {}}
          onStop={() => setView(null)}
          load={load}
          style={{ height: 240 }}
        />
      )}
      <TextInput
        accessibilityLabel="対応理由"
        placeholder="対応理由（必須）"
        value={note}
        onChangeText={setNote}
        multiline
        maxLength={500}
        style={{
          padding: 12,
          minHeight: 80,
          borderWidth: 1,
          borderColor: c.muted,
          borderRadius: 10,
          color: c.ink,
        }}
      />
      {['ALLOWED', 'BLOCKED', ...(item.moderation !== 'PENDING' ? ['DISMISS'] : [])].map(
        (action) => (
          <Button
            key={action}
            secondary={action !== 'BLOCKED'}
            disabled={busy || !opened || !note.trim()}
            onPress={() =>
              void (async () => {
                setBusy(true);
                setError('');
                try {
                  await api(`/v1/moderation/posts/${item.post_id}/decision`, {
                    action,
                    note,
                    revision: item.revision,
                  });
                  refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : '保存できませんでした。');
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {action === 'ALLOWED'
              ? '掲載を許可'
              : action === 'BLOCKED'
                ? '掲載を停止'
                : '通報を対応不要として終了'}
          </Button>
        ),
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.red }}>
          {error}
        </Text>
      )}
    </View>
  );
}

function AccountReview({ item, refresh }: { item: AccountReport; refresh: () => void }) {
  const [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function decide(action: 'SUSPEND' | 'DISMISS') {
    setBusy(true);
    setError('');
    try {
      await api(`/v1/moderation/reports/${item.report_id}/decision`, { action, note });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ padding: 16, gap: 12, borderRadius: 16, backgroundColor: '#EDF1E8' }}>
      <Text style={{ color: c.ink, fontWeight: '700' }}>ユーザーへの通報：{item.display_name}</Text>
      <Text selectable style={{ color: c.muted }}>
        対象ID：{item.target_user_id}
      </Text>
      <Text style={{ color: c.ink }}>
        理由：{item.reason}
        {'\n'}
        {item.details}
      </Text>
      <Text style={{ color: c.ink, lineHeight: 22 }}>
        通報の記載だけで判断せず、運営で事実を確認してください。利用停止すると、全端末からの利用と投稿・証明リンクの公開を止めます。異議申立て・削除はWeb窓口で受け付けます。
      </Text>
      <TextInput
        accessibilityLabel="ユーザー通報への対応理由"
        multiline
        maxLength={500}
        placeholder="確認した事実と対応理由（必須）"
        value={note}
        onChangeText={setNote}
        style={{
          padding: 12,
          minHeight: 80,
          color: c.ink,
          borderWidth: 1,
          borderColor: c.muted,
          borderRadius: 10,
        }}
      />
      <Button
        disabled={busy || !note.trim()}
        onPress={() =>
          Alert.alert(
            'ユーザーの利用を停止',
            'すべてのログイン・投稿・証明リンクを停止します。確認した内容に基づく対応ですか？',
            [
              { text: '戻る', style: 'cancel' },
              { text: '利用を停止', style: 'destructive', onPress: () => void decide('SUSPEND') },
            ],
          )
        }
      >
        利用を停止
      </Button>
      <Button secondary disabled={busy || !note.trim()} onPress={() => void decide('DISMISS')}>
        対応不要として終了
      </Button>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.red }}>
          {error}
        </Text>
      )}
    </View>
  );
}
