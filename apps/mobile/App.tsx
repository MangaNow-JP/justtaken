import { LocationPreferenceProvider } from './src/preferences/LocationPreference';
import { LocationSettings } from './src/components/LocationSettings';
import { AccountSettings } from './src/components/AccountSettings';
import { CommunityConsent } from './src/components/CommunityConsent';
import { Moderation } from './src/screens/Moderation';
import { LegalLinks } from './src/components/LegalLinks';
import { CaptureLocationRecord } from './src/components/CaptureLocationRecord';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureModule, type LocalCapture } from '@justtaken/capture';
import { countGraphemes } from '@justtaken/contracts/text';
import { colors as c } from './src/theme';
import { appStyles as s } from './src/appStyles';
import {
  Avatar,
  Photo,
  Button,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
} from './src/components/UI';
import { Feed } from './src/screens/Feed';
import { WatermarkPreferenceProvider } from './src/preferences/WatermarkPreference';
import { WatermarkSettings } from './src/components/WatermarkSettings';
import { OriginalPhoto } from './src/components/OriginalPhoto';
import { VideoPreview } from './src/components/VideoPreview';
import { Camera } from './src/screens/Camera';
import { CaptureRecord } from './src/screens/Record';
import { demoPosts, type DemoPost } from './src/data/demo';
import { AuthProvider, useAuth } from './src/services/auth';
import { Login } from './src/screens/Login';
import { Posts } from './src/screens/Posts';
import { Proofs } from './src/screens/Proofs';
import { logout } from './src/services/api';
import {
  commitCapture,
  certifyCapture,
  postCapture,
  discardCapture,
  listAccountDrafts,
  type UploadPhase,
} from './src/services/capture';

type Tab = 'home' | 'explore' | 'camera' | 'notifications' | 'profile';
type Sheet =
  | { kind: 'record' | 'comments' | 'more'; post: DemoPost }
  | { kind: 'about' | 'settings' | 'saved' | 'login' | 'posts' | 'proofs' | 'moderation' }
  | { kind: 'compose'; capture: LocalCapture };
type DraftNote = { caption: string; visibility: 'followers' | 'private' | 'public' };
const tabs: { id: Tab; icon: IconName; label: string }[] = [
  { id: 'home', icon: 'home', label: 'ホーム' },
  { id: 'explore', icon: 'search', label: '探す' },
  { id: 'camera', icon: 'camera', label: '撮る' },
  { id: 'notifications', icon: 'bell', label: '通知' },
  { id: 'profile', icon: 'user', label: 'マイページ' },
];
export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <WatermarkPreferenceProvider>
          <LocationPreferenceProvider>
            <JustTaken />
          </LocationPreferenceProvider>
        </WatermarkPreferenceProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
function JustTaken() {
  const { width, height } = useWindowDimensions();
  const { profile, policy, consentRequired } = useAuth();
  const [postRevision, setPostRevision] = useState(0);
  const [sending, setSending] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase | null>(null);
  const [uploadError, setUploadError] = useState('');
  const desktop = Platform.OS === 'web' && width > 900;
  const [tab, setTab] = useState<Tab>('home');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [likes, setLikes] = useState<string[]>([]);
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [draftNotes, setDraftNotes] = useState<Record<string, DraftNote>>({});
  const [hydrated, setHydrated] = useState(false);
  const [playingDraft, setPlayingDraft] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<LocalCapture[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('すべて');
  const [toast, setToast] = useState('');
  const [comment, setComment] = useState('');
  const [comments, setComments] = useState<Record<string, string[]>>({});
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<'followers' | 'private' | 'public'>('private');
  useEffect(() => {
    AsyncStorage.getItem('justtaken.preview.v1')
      .then((raw) => {
        if (raw) {
          const data = JSON.parse(raw);
          setLikes(data.likes ?? []);
          setBookmarks(data.bookmarks ?? []);
          setDraftNotes(data.draftNotes ?? {});
          setComments(data.comments ?? {});
        }
      })
      .catch(() => setToast('端末内の保存データを読み込めませんでした'))
      .finally(() => setHydrated(true));
  }, []);
  useEffect(() => {
    if (hydrated)
      void AsyncStorage.setItem(
        'justtaken.preview.v1',
        JSON.stringify({ likes, bookmarks, draftNotes, comments }),
      ).catch(() => setToast('変更を端末に保存できませんでした'));
  }, [likes, bookmarks, draftNotes, comments, hydrated]);
  useEffect(() => {
    let active = true;
    setDrafts([]);
    if (tab === 'profile' && captureModule)
      void listAccountDrafts(profile?.userId)
        .then((value) => {
          if (active) setDrafts(value);
        })
        .catch(() => {
          if (active) setToast('下書きを読み込めませんでした');
        });
    return () => {
      active = false;
    };
  }, [tab, sheet, profile?.userId]);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timeout);
  }, [toast]);
  const toggle = (values: string[], id: string) =>
    values.includes(id) ? values.filter((v) => v !== id) : [...values, id];
  function openDraft(capture: LocalCapture) {
    setUploadError('');
    setUploadPhase(null);
    const note = draftNotes[capture.handle];
    setCaption(note?.caption ?? '');
    setVisibility(note?.visibility ?? 'private');
    setPlayingDraft(null);
    setSheet({ kind: 'compose', capture });
  }
  const currentTitle =
    tab === 'explore' ? '見つける' : tab === 'notifications' ? 'お知らせ' : 'マイページ';
  const sheetTitle =
    sheet?.kind === 'moderation'
      ? '運営の確認待ち'
      : sheet?.kind === 'proofs'
        ? 'あなたの撮影証明'
        : sheet?.kind === 'login'
          ? 'ログイン'
          : sheet?.kind === 'posts'
            ? 'あなたの投稿'
            : sheet?.kind === 'record'
              ? '撮影記録'
              : sheet?.kind === 'comments'
                ? 'コメント'
                : sheet?.kind === 'compose'
                  ? '撮影証明・投稿'
                  : sheet?.kind === 'saved'
                    ? '保存した投稿'
                    : sheet?.kind === 'settings'
                      ? '設定'
                      : sheet?.kind === 'more'
                        ? '投稿について'
                        : 'JustTakenについて';
  const filtered = demoPosts.filter(
    (p) =>
      (!query ||
        `${p.name} ${p.handle} ${p.caption} ${p.category}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (category === 'すべて' || category === p.category),
  );
  return (
    <View style={[s.outer, desktop && s.desktop]}>
      <StatusBar style={tab === 'camera' ? 'light' : 'dark'} />
      {desktop && (
        <View style={s.intro}>
          <Image
            source={require('./assets/justtaken-logo.png')}
            style={s.introLogo}
            resizeMode="contain"
          />
          <View style={s.previewPill}>
            <View style={s.dot} />
            <Text style={s.previewPillText}>DEVELOPMENT PREVIEW · 0.1</Text>
          </View>
          <Text style={s.introTitle}>{'いま撮った、\nその瞬間を。'}</Text>
          <Text style={s.introCopy}>
            {'飾らない日常に、心が動く。\n専用カメラで撮った写真と、\nその撮影記録を共有する場所。'}
          </Text>
          <View style={s.introRule} />
          <Text style={s.introSmall}>
            {'iOS & Android\n画面を操作して、最初の体験を確かめられます。'}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSheet({ kind: 'about' })}
            style={s.aboutLink}
          >
            <Text style={s.aboutLinkText}>JustTakenの撮影記録について</Text>
            <Icon name="arrow-up-right" size={15} />
          </Pressable>
        </View>
      )}
      <View
        style={[
          s.phone,
          desktop && {
            width: 414,
            height: Math.min(height - 64, 920),
            borderRadius: 36,
            borderWidth: 7,
            borderColor: '#173A31',
            boxShadow: '0 24px 80px #12372b18',
            flex: undefined,
          },
        ]}
      >
        <SafeAreaView
          edges={['top', 'bottom']}
          style={[s.safe, tab === 'camera' && { backgroundColor: '#10221C' }]}
        >
          {(tab !== 'camera' || consentRequired) && (
            <View style={s.header}>
              <Image
                source={require('./assets/justtaken-logo.png')}
                style={s.logo}
                resizeMode="contain"
              />
              <View style={{ flex: 1 }} />
              <IconButton
                name={tab === 'profile' ? 'settings' : 'info'}
                label={tab === 'profile' ? '設定' : 'JustTakenについて'}
                onPress={() => setSheet({ kind: tab === 'profile' ? 'settings' : 'about' })}
              />
            </View>
          )}
          <View style={s.main}>
            {!hydrated ? (
              <ActivityIndicator color={c.ink} />
            ) : profile && consentRequired && (tab === 'home' || tab === 'camera') ? (
              <CommunityConsent />
            ) : tab === 'home' && profile ? (
              <Posts
                key={profile.userId}
                activeView={!sheet}
                revision={postRevision}
                onCamera={() => setTab('camera')}
              />
            ) : tab === 'home' && Platform.OS !== 'web' ? (
              <ScrollView contentContainerStyle={{ padding: 24 }}>
                <Login onSuccess={() => setTab('home')} />
              </ScrollView>
            ) : tab === 'home' ? (
              <Feed
                likes={likes}
                bookmarks={bookmarks}
                onLike={(id) => setLikes((v) => toggle(v, id))}
                onBookmark={(id) => setBookmarks((v) => toggle(v, id))}
                onRecord={(post) => setSheet({ kind: 'record', post })}
                onComments={(post) => {
                  setComment('');
                  setSheet({ kind: 'comments', post });
                }}
                onMore={(post) => setSheet({ kind: 'more', post })}
                onExplore={() => setTab('explore')}
                onCamera={() => setTab('camera')}
              />
            ) : tab === 'camera' ? (
              <Camera
                key={profile?.userId ?? 'guest'}
                userId={profile?.userId}
                onLogin={() => setSheet({ kind: 'login' })}
                onClose={() => setTab('home')}
                onCapture={(capture) => {
                  setTab('profile');
                  openDraft(capture);
                  void commitCapture(capture).catch((error) =>
                    setUploadError(
                      error instanceof Error ? error.message : '撮影記録を確定できませんでした。',
                    ),
                  );
                }}
              />
            ) : (
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={s.page}
                keyboardShouldPersistTaps="handled"
              >
                <Text style={s.pageEyebrow}>
                  {tab === 'explore'
                    ? 'LITTLE DISCOVERIES'
                    : tab === 'profile'
                      ? 'YOUR LITTLE MOMENTS'
                      : 'STAY CONNECTED'}
                </Text>
                <Text style={s.pageTitle}>{currentTitle}</Text>
                {tab === 'explore' ? (
                  <>
                    <View style={s.search}>
                      <Icon name="search" size={19} color={c.muted} />
                      <TextInput
                        accessibilityLabel="ユーザーや言葉で検索"
                        placeholder="ユーザーや、気になる言葉"
                        placeholderTextColor={c.muted}
                        value={query}
                        onChangeText={setQuery}
                        style={s.searchInput}
                      />
                      {!!query && (
                        <IconButton name="x" label="検索を消去" onPress={() => setQuery('')} />
                      )}
                    </View>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={s.chips}
                    >
                      {['すべて', '日々のこと', '散歩', '景色'].map((item) => (
                        <Pressable
                          key={item}
                          accessibilityRole="button"
                          accessibilityState={{ selected: category === item }}
                          onPress={() => setCategory(item)}
                          style={[s.chip, item === category && { backgroundColor: c.ink }]}
                        >
                          <Text style={[s.chipText, item === category && { color: 'white' }]}>
                            {item}
                          </Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                    <View style={s.sectionHeading}>
                      <Text style={s.sectionTitle}>日常から、見つけよう。</Text>
                      <Text style={s.small}>サンプル写真</Text>
                    </View>
                    <View style={s.grid}>
                      {filtered.map((post) => (
                        <Pressable
                          key={post.id}
                          accessibilityRole="button"
                          accessibilityLabel={`${post.name}の${post.category}を見る`}
                          onPress={() => setSheet({ kind: 'record', post })}
                          style={s.gridItem}
                        >
                          <Photo source={post.photo} style={s.gridPhoto} />
                          <Text style={s.gridName}>{post.name}</Text>
                          <Text style={s.small}>#{post.category}</Text>
                        </Pressable>
                      ))}
                    </View>
                    {!filtered.length && (
                      <EmptyState icon="search" title="まだ、見つかりませんでした">
                        別の言葉で探してみてください。
                      </EmptyState>
                    )}
                  </>
                ) : tab === 'notifications' ? (
                  <>
                    <View style={s.notice}>
                      <Icon name="bell" size={16} />
                      <Text style={s.noticeText}>新しいつながりは、ここに届きます。</Text>
                    </View>
                    <EmptyState icon="inbox" title="まだ、お知らせはありません">
                      フォローやコメントのお知らせをまとめます。現在は開発プレビューです。
                    </EmptyState>
                  </>
                ) : (
                  <>
                    <View style={s.profile}>
                      <Avatar initial="J" size={76} />
                      <Text style={s.profileName}>
                        {profile?.displayName ?? 'あなたの、小さな記録。'}
                      </Text>
                      <Text style={s.small}>
                        {profile ? 'ログイン済み' : 'ログインして、日常を残そう'}
                      </Text>
                      <View style={s.privateTag}>
                        <Icon name="lock" size={12} />
                        <Text style={s.privateText}>非公開アカウントが初期設定です</Text>
                      </View>
                    </View>
                    {!profile ? (
                      <Button icon="user" onPress={() => setSheet({ kind: 'login' })}>
                        ログイン / はじめる
                      </Button>
                    ) : (
                      <Button icon="image" onPress={() => setSheet({ kind: 'posts' })}>
                        あなたの投稿を見る
                      </Button>
                    )}
                    <Button
                      icon="shield"
                      secondary
                      onPress={() => setSheet({ kind: profile ? 'proofs' : 'login' })}
                    >
                      あなたの撮影証明を見る
                    </Button>
                    <View style={s.stats}>
                      <View>
                        <Text style={s.statValue}>{drafts.length}</Text>
                        <Text style={s.statLabel}>端末の下書き</Text>
                      </View>
                      {Platform.OS === 'web' && (
                        <>
                          <View style={s.statDivider} />
                          <Pressable
                            accessibilityRole="button"
                            onPress={() => setSheet({ kind: 'saved' })}
                          >
                            <Text style={s.statValue}>{bookmarks.length}</Text>
                            <Text style={s.statLabel}>保存したサンプル</Text>
                          </Pressable>
                        </>
                      )}
                    </View>
                    <View style={s.sectionHeading}>
                      <Text style={s.sectionTitle}>下書き</Text>
                      <Icon name="lock" size={15} color={c.muted} />
                    </View>
                    {drafts.length ? (
                      <View style={s.grid}>
                        {drafts.map((draft) => (
                          <Pressable
                            key={draft.handle}
                            accessibilityRole="button"
                            accessibilityLabel="撮影した下書きを開く"
                            style={s.gridItem}
                            onPress={() => openDraft(draft)}
                          >
                            <Photo source={{ uri: draft.previewUri }} style={s.gridPhoto} />
                            <Text style={s.small}>端末に保存した撮影データ</Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : (
                      <>
                        <EmptyState icon="camera" title="最初の瞬間を、残そう。">
                          気になった景色も、いつもの一杯も。あなたのカメラから始まります。
                        </EmptyState>
                        <Button onPress={() => setTab('camera')} icon="camera">
                          カメラを開く
                        </Button>
                      </>
                    )}
                  </>
                )}
              </ScrollView>
            )}
          </View>
          {(tab !== 'camera' || consentRequired) && (
            <View style={s.nav}>
              {tabs
                .filter(
                  (item) =>
                    Platform.OS === 'web' || ['home', 'camera', 'profile'].includes(item.id),
                )
                .map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="tab"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: tab === item.id }}
                    onPress={() => setTab(item.id)}
                    style={s.navItem}
                  >
                    {item.id === 'camera' ? (
                      <View style={s.cameraTab}>
                        <Icon name="camera" size={25} />
                      </View>
                    ) : (
                      <Icon
                        name={item.icon}
                        size={21}
                        color={tab === item.id ? c.ink : '#8A948C'}
                      />
                    )}
                    <Text
                      style={[s.navText, tab === item.id && { color: c.ink, fontWeight: '700' }]}
                    >
                      {item.label}
                    </Text>
                    {tab === item.id && <View style={s.navDot} />}
                  </Pressable>
                ))}
            </View>
          )}
        </SafeAreaView>
      </View>
      <Modal
        visible={sheet !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!sending) setSheet(null);
        }}
        transparent={Platform.OS === 'web'}
      >
        <View style={[s.modalBackdrop, Platform.OS !== 'web' && { backgroundColor: c.background }]}>
          <SafeAreaView
            style={[
              s.modalBody,
              desktop && { maxWidth: 460, maxHeight: height - 60, borderRadius: 28 },
            ]}
          >
            <View style={s.sheetHeader}>
              <IconButton
                name="arrow-left"
                label="閉じる"
                onPress={() => {
                  if (!sending) setSheet(null);
                }}
              />
              <Text style={s.sheetTitle}>{sheetTitle}</Text>
              <View style={{ width: 44 }} />
            </View>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={{ flex: 1 }}
            >
              {sheet?.kind === 'moderation' ? (
                <Moderation />
              ) : sheet?.kind === 'proofs' ? (
                <Proofs
                  key={profile?.userId}
                  onCamera={() => {
                    setSheet(null);
                    setTab('camera');
                  }}
                />
              ) : sheet?.kind === 'posts' ? (
                <Posts
                  key={profile?.userId}
                  scope="mine"
                  revision={postRevision}
                  onCamera={() => {
                    setSheet(null);
                    setTab('camera');
                  }}
                />
              ) : sheet?.kind === 'record' ? (
                <CaptureRecord post={sheet.post} />
              ) : (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  onScrollBeginDrag={() => setPlayingDraft(null)}
                  contentContainerStyle={s.sheetContent}
                >
                  {sheet?.kind === 'login' && (
                    <Login
                      onSuccess={() => {
                        setSheet(null);
                        setTab('profile');
                      }}
                    />
                  )}
                  {sheet?.kind === 'about' && (
                    <>
                      <Image
                        source={require('./assets/justtaken-logo.png')}
                        style={{ width: 245, height: 82, alignSelf: 'center' }}
                        resizeMode="contain"
                      />
                      <Text style={s.sheetHero}>いま撮った、その瞬間を。</Text>
                      <Text style={s.small}>運営：株式会社IMAKAI</Text>
                      <Text style={s.bodyText}>
                        JustTakenは、アプリのカメラで撮った写真・動画に、検証できる撮影証明を添えるアプリです。SNSに投稿せず、証明だけを保存・共有することもできます。
                      </Text>
                      <InfoRow
                        icon="camera"
                        title="このアプリのカメラから"
                        copy="ギャラリーからの取り込みや、外部画像の投稿は行いません。"
                      />
                      <InfoRow
                        icon="shield"
                        title="撮影記録とファイルの一致"
                        copy="端末の撮影記録と、保存したファイルの整合性を確認します。写っている内容の真偽を保証するものではありません。"
                      />
                      <InfoRow
                        icon="lock"
                        title="公開する相手は、あなたが選ぶ"
                        copy="非公開アカウントを初期設定に。GPSは設定でオンにした撮影時だけ取得し、自分の記録に保存します。連絡先は取得しません。写真の原本には、撮影機種や現像に必要な情報を保持します。"
                      />
                      <View style={s.notice}>
                        <Text style={s.noticeText}>
                          現在は開発プレビューです。フィードの写真・撮影記録はサンプルで、いいね・保存・コメントはこの端末内だけに記録されます。
                        </Text>
                      </View>
                    </>
                  )}
                  {sheet?.kind === 'comments' && (
                    <>
                      <Text style={s.bodyText}>
                        {sheet.post.name}「{sheet.post.caption}」
                      </Text>
                      <Text style={s.small}>
                        この端末内だけのコメント体験です。外部には送信されません。
                      </Text>
                      {(comments[sheet.post.id] ?? []).map((text, i) => (
                        <View key={i} style={s.commentRow}>
                          <Avatar initial="J" size={32} />
                          <View style={{ flex: 1 }}>
                            <Text style={s.commentName}>あなた · ローカル</Text>
                            <Text style={s.bodyText}>{text}</Text>
                          </View>
                        </View>
                      ))}
                      <TextInput
                        accessibilityLabel="コメント"
                        value={comment}
                        onChangeText={setComment}
                        placeholder="ひとこと、残してみよう"
                        placeholderTextColor={c.muted}
                        multiline
                        style={s.textArea}
                      />
                      <Text style={s.small}>{countGraphemes(comment)} / 300</Text>
                      <Button
                        disabled={!comment.trim() || countGraphemes(comment) > 300}
                        onPress={() => {
                          const id = sheet.post.id;
                          setComments((v) => ({ ...v, [id]: [...(v[id] ?? []), comment.trim()] }));
                          setComment('');
                        }}
                      >
                        端末にコメントを保存
                      </Button>
                    </>
                  )}
                  {sheet?.kind === 'more' && (
                    <>
                      <Text style={s.bodyText}>これは {sheet.post.name} のサンプル投稿です。</Text>
                      <Button
                        secondary
                        icon="shield"
                        onPress={() => setSheet({ kind: 'record', post: sheet.post })}
                      >
                        撮影記録を見る
                      </Button>
                      <Button
                        secondary
                        icon="bookmark"
                        onPress={() => {
                          setBookmarks((v) => toggle(v, sheet.post.id));
                          setSheet(null);
                        }}
                      >
                        {bookmarks.includes(sheet.post.id) ? '保存を解除' : 'この端末に保存'}
                      </Button>
                      <Text style={s.small}>
                        通報・ブロックは、アカウント機能の接続後に利用できるようになります。
                      </Text>
                    </>
                  )}
                  {sheet?.kind === 'settings' && (
                    <>
                      <LocationSettings />
                      <WatermarkSettings />
                      <LegalLinks />
                      <AccountSettings
                        onDeleted={() => {
                          setDrafts([]);
                          setDraftNotes({});
                          setLikes([]);
                          setBookmarks([]);
                          setComments({});
                          setPostRevision((v) => v + 1);
                        }}
                        onModeration={() => setSheet({ kind: 'moderation' })}
                      />
                      <InfoRow
                        icon="lock"
                        title="公開範囲"
                        copy="非公開アカウントが初期設定です。投稿ごとに共有する相手を選べます。"
                      />
                      <InfoRow
                        icon="hard-drive"
                        title="保存枠"
                        copy="保存枠は2 GiBです。写真・動画の原画を保存します。送信に失敗した場合は下書きから再送できます。"
                      />
                      <InfoRow icon="smartphone" title="運営会社" copy="株式会社IMAKAI" />
                      <InfoRow
                        icon="smartphone"
                        title="アプリ情報"
                        copy="JustTaken 1.0.0 · iOS / Android。ログインと撮影認証は専用アプリから利用します。"
                      />
                      {profile && (
                        <>
                          <Button
                            secondary
                            icon="log-out"
                            onPress={async () => {
                              try {
                                await logout();
                                setDrafts([]);
                                setSheet(null);
                                setToast('ログアウトしました');
                              } catch {
                                setDrafts([]);
                                setSheet(null);
                                setToast('この端末からログアウトしました');
                              }
                            }}
                          >
                            ログアウト
                          </Button>
                          <Button
                            secondary
                            onPress={async () => {
                              try {
                                await logout(true);
                                setDrafts([]);
                                setSheet(null);
                                setToast('すべての端末からログアウトしました');
                              } catch (error) {
                                setToast(
                                  error instanceof Error
                                    ? error.message
                                    : '通信状態を確認してください',
                                );
                              }
                            }}
                          >
                            すべての端末からログアウト
                          </Button>
                        </>
                      )}
                      <Button secondary onPress={() => setSheet({ kind: 'about' })}>
                        JustTakenについて
                      </Button>
                    </>
                  )}
                  {sheet?.kind === 'saved' &&
                    (bookmarks.length ? (
                      demoPosts
                        .filter((p) => bookmarks.includes(p.id))
                        .map((post) => (
                          <Pressable
                            accessibilityRole="button"
                            key={post.id}
                            onPress={() => setSheet({ kind: 'record', post })}
                          >
                            <Photo source={post.photo} style={s.savedPhoto} />
                            <Text style={s.bodyText}>
                              {post.name} · {post.caption}
                            </Text>
                          </Pressable>
                        ))
                    ) : (
                      <EmptyState icon="bookmark" title="気になる瞬間を、ここに。">
                        投稿のしおりマークを押すと、この端末に保存できます。
                      </EmptyState>
                    ))}
                  {sheet?.kind === 'compose' && (
                    <>
                      <CaptureLocationRecord location={sheet.capture.location} />
                      {sheet.capture.kind === 'video' ? (
                        <VideoPreview
                          poster={{ uri: sheet.capture.previewUri }}
                          style={{ height: 380, borderRadius: 16, overflow: 'hidden' }}
                          active={playingDraft === sheet.capture.handle}
                          onPlay={() => setPlayingDraft(sheet.capture.handle)}
                          onStop={() => setPlayingDraft(null)}
                          load={async () => ({ uri: sheet.capture.mediaUri! })}
                        />
                      ) : (
                        <OriginalPhoto
                          preview={{ uri: sheet.capture.previewUri }}
                          style={s.savedPhoto}
                          active={playingDraft === sheet.capture.handle}
                          onOpen={() => setPlayingDraft(sheet.capture.handle)}
                          onClose={() => setPlayingDraft(null)}
                          load={async () => ({
                            uri: sheet.capture.mediaUri ?? sheet.capture.previewUri,
                          })}
                        />
                      )}
                      <View style={s.notice}>
                        <Icon name="clock" size={17} />
                        <Text style={s.noticeText}>
                          {uploadPhase
                            ? {
                                authenticating: '端末を認証中…',
                                committing: '撮影記録を確定中…',
                                uploading: '撮影データを送信中…',
                                verifying: 'ファイルと撮影記録を照合中…',
                                certifying: '署名付き撮影証明を保存中…',
                                posting: '投稿を保存中…',
                                done: '処理を完了しました',
                              }[uploadPhase]
                            : sheet.capture.kind === 'video'
                              ? `動画 · ${((sheet.capture.assets[0].durationMs ?? 0) / 1000).toFixed(1)}秒 · ${sheet.capture.assets[0].audioCodec ? '音声あり' : '無音'}`
                              : '撮影した写真 · 原本と撮影記録'}
                        </Text>
                      </View>
                      <Text style={s.small}>
                        {sheet.capture.policyVersion === 'capture-v2' ||
                        sheet.capture.policyVersion === 'capture-v3'
                          ? '原画を保持 · '
                          : '以前の画質設定 · '}
                        {sheet.capture.assets[0].width} × {sheet.capture.assets[0].height} ·{' '}
                        {(
                          sheet.capture.assets.reduce((sum, a) => sum + a.bytes, 0) / 1048576
                        ).toFixed(1)}{' '}
                        MiB
                        {sheet.capture.kind === 'photo' &&
                          ` · ${sheet.capture.assets[0].mime === 'image/heic' ? 'HEIF' : sheet.capture.assets[0].mime === 'image/x-adobe-dng' ? 'RAW (DNG)' : 'JPEG'}${sheet.capture.assets[0].hasGainMap ? ' · HDRゲインマップあり' : ''}`}
                      </Text>
                      <Text style={s.sectionTitle}>SNSに投稿せず、撮影証明を残す</Text>
                      <Text style={s.small}>
                        原本を非公開で保存して照合し、署名付き証明を発行します。共有は保存後に選べます。投稿の公開範囲・キャプションは証明には含みません。
                      </Text>
                      <Button
                        icon="shield"
                        disabled={
                          sending || !profile || !sheet.capture.session || !policy?.captureEnabled
                        }
                        onPress={async () => {
                          setPlayingDraft(null);
                          setSending(true);
                          setUploadError('');
                          try {
                            await certifyCapture(sheet.capture, setUploadPhase);
                            setSheet({ kind: 'proofs' });
                            setToast('撮影証明を保存しました。SNSには投稿していません');
                          } catch (error) {
                            setUploadError(
                              error instanceof Error
                                ? error.message
                                : '証明を保存できませんでした。',
                            );
                          } finally {
                            setSending(false);
                          }
                        }}
                      >
                        投稿せずに撮影証明を保存
                      </Button>
                      <Text style={s.sectionTitle}>SNSにも投稿する</Text>
                      <TextInput
                        accessibilityLabel="キャプション"
                        multiline
                        placeholder="この瞬間に、ひとこと。"
                        placeholderTextColor={c.muted}
                        style={s.textArea}
                        editable={!sending}
                        value={caption}
                        onChangeText={setCaption}
                      />
                      <Text style={[s.small, countGraphemes(caption) > 500 && { color: c.red }]}>
                        {countGraphemes(caption)} / 500
                      </Text>
                      <Text style={s.sectionTitle}>投稿時の公開範囲</Text>
                      {(
                        [
                          { value: 'public', label: 'すべてのユーザー' },
                          { value: 'private', label: '自分のみ' },
                        ] as const
                      )
                        .filter((option) => option.value !== 'public' || !profile?.isPrivate)
                        .map((option) => (
                          <Pressable
                            accessibilityRole="radio"
                            accessibilityState={{ checked: visibility === option.value }}
                            key={option.value}
                            disabled={sending}
                            onPress={() => setVisibility(option.value)}
                            style={s.option}
                          >
                            <Icon
                              name={visibility === option.value ? 'check-circle' : 'circle'}
                              size={19}
                            />
                            <Text style={s.bodyText}>{option.label}</Text>
                          </Pressable>
                        ))}
                      <Text style={s.small}>
                        ファイルと撮影記録の照合、内容の確認を経て投稿されます。写っている内容の真偽を保証するものではありません。
                      </Text>
                      {!!uploadError && (
                        <Text accessibilityRole="alert" style={[s.bodyText, { color: c.red }]}>
                          {uploadError}
                        </Text>
                      )}
                      <Button
                        icon="send"
                        disabled={
                          sending ||
                          !profile ||
                          !sheet.capture.session ||
                          !policy?.captureEnabled ||
                          countGraphemes(caption) > 500
                        }
                        onPress={async () => {
                          const capture = sheet.capture;
                          setPlayingDraft(null);
                          setSending(true);
                          setUploadError('');
                          setDraftNotes((v) => ({
                            ...v,
                            [capture.handle]: { caption, visibility },
                          }));
                          try {
                            const post = await postCapture(
                              capture,
                              caption,
                              visibility,
                              setUploadPhase,
                            );
                            await captureModule?.discard(capture.handle);
                            setPostRevision((v) => v + 1);
                            setSheet(null);
                            setTab('home');
                            setToast(
                              post.state === 'PUBLISHED'
                                ? '投稿しました'
                                : '投稿を受け付けました。内容を確認中です',
                            );
                          } catch (error) {
                            setUploadError(
                              error instanceof Error
                                ? error.message
                                : '送信できませんでした。下書きから再試行できます。',
                            );
                          } finally {
                            setSending(false);
                          }
                        }}
                      >
                        {sending
                          ? '処理しています…'
                          : uploadError
                            ? 'もう一度投稿する'
                            : 'この瞬間を投稿する'}
                      </Button>
                      <Button
                        disabled={sending || countGraphemes(caption) > 500}
                        onPress={() => {
                          setDraftNotes((v) => ({
                            ...v,
                            [sheet.capture.handle]: { caption, visibility },
                          }));
                          setSheet(null);
                          setToast('下書きをこの端末に保存しました');
                        }}
                      >
                        下書きを保存
                      </Button>
                      <Button
                        secondary
                        disabled={sending}
                        onPress={async () => {
                          try {
                            await discardCapture(sheet.capture);
                            setDraftNotes((v) => {
                              const next = { ...v };
                              delete next[sheet.capture.handle];
                              return next;
                            });
                            setSheet(null);
                            setToast('下書きを削除しました');
                          } catch {
                            setToast('下書きを削除できませんでした');
                          }
                        }}
                      >
                        端末の下書きを削除（保存済みの証明は残す）
                      </Button>
                    </>
                  )}
                </ScrollView>
              )}
            </KeyboardAvoidingView>
          </SafeAreaView>
        </View>
      </Modal>
      {!!toast && (
        <View accessibilityRole="alert" style={s.toast}>
          <Text style={s.toastText}>{toast}</Text>
        </View>
      )}
    </View>
  );
}
function InfoRow({ icon, title, copy }: { icon: IconName; title: string; copy: string }) {
  return (
    <View style={s.infoRow}>
      <View style={s.infoIcon}>
        <Icon name={icon} size={20} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={s.sectionTitle}>{title}</Text>
        <Text style={[s.bodyText, { marginTop: 7, color: c.muted }]}>{copy}</Text>
      </View>
    </View>
  );
}
