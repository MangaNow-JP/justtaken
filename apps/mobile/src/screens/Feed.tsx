import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors as c } from '../theme';
import { demoPosts, type DemoPost } from '../data/demo';
import { Avatar, Icon, IconButton, Photo } from '../components/UI';

export function Feed({
  likes,
  bookmarks,
  onLike,
  onBookmark,
  onRecord,
  onComments,
  onMore,
  onExplore,
  onCamera,
}: {
  likes: string[];
  bookmarks: string[];
  onLike: (id: string) => void;
  onBookmark: (id: string) => void;
  onRecord: (post: DemoPost) => void;
  onComments: (post: DemoPost) => void;
  onMore: (post: DemoPost) => void;
  onExplore: () => void;
  onCamera: () => void;
}) {
  return (
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 30 }}>
      <View style={s.heading}>
        <View>
          <Text style={s.eyebrow}>YOUR EVERYDAY, AS IT IS.</Text>
          <Text style={s.title}>日々の、ありのまま。</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="カメラを開く"
          onPress={onCamera}
          style={s.sun}
        >
          <Icon name="sun" size={25} />
        </Pressable>
      </View>
      <View style={s.tabs}>
        <View style={s.tabActive}>
          <Text style={s.tabText}>フォロー中</Text>
          <View style={s.underline} />
        </View>
        <Pressable accessibilityRole="button" onPress={onExplore} style={s.tab}>
          <Text style={s.tabMuted}>見つける</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Text style={s.sampleTag}>サンプル</Text>
      </View>
      {demoPosts.map((post) => (
        <View key={post.id} style={s.card}>
          <View style={s.author}>
            <Avatar initial={post.initial} color={post.color} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.name}>{post.name}</Text>
              <Text style={s.time}>{post.time} · 表示例</Text>
            </View>
            <IconButton
              name="more-horizontal"
              label={`${post.name}の投稿メニュー`}
              onPress={() => onMore(post)}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${post.description}。撮影記録のサンプルを開く`}
            onPress={() => onRecord(post)}
          >
            <Photo source={post.photo} style={s.photo} accessibilityLabel={post.description} />
          </Pressable>
          <View style={s.body}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="撮影記録のサンプルを見る"
              onPress={() => onRecord(post)}
              style={s.badge}
            >
              <Icon name="shield" size={14} />
              <Text style={s.badgeText}>撮影記録を見る</Text>
              <Text style={s.badgeSample}>サンプル</Text>
              <Icon name="chevron-right" size={13} />
            </Pressable>
            <View style={s.reactions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="いいね"
                accessibilityState={{ selected: likes.includes(post.id) }}
                onPress={() => onLike(post.id)}
                style={s.reaction}
              >
                <Icon name="heart" color={likes.includes(post.id) ? c.red : c.ink} />
                <Text style={s.count}>{post.likes + (likes.includes(post.id) ? 1 : 0)}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="コメントを見る"
                onPress={() => onComments(post)}
                style={s.reaction}
              >
                <Icon name="message-circle" />
                <Text style={s.count}>{post.comments}</Text>
              </Pressable>
              <View style={{ flex: 1 }} />
              <IconButton
                name="bookmark"
                label={bookmarks.includes(post.id) ? '保存を解除' : '投稿を保存'}
                color={bookmarks.includes(post.id) ? '#7C9F37' : c.ink}
                onPress={() => onBookmark(post.id)}
              />
            </View>
            <Text style={s.caption}>{post.caption}</Text>
            <Text style={s.category}>#{post.category}</Text>
          </View>
        </View>
      ))}
      <Text style={s.end}>今日の小さな瞬間を、大切に。</Text>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  heading: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eyebrow: { color: c.muted, fontSize: 9, fontWeight: '600', letterSpacing: 2 },
  title: { color: c.ink, fontSize: 25, fontWeight: '600', letterSpacing: 0.6, marginTop: 9 },
  sun: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: c.pale,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    marginHorizontal: 24,
    flexDirection: 'row',
    gap: 26,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: c.line,
  },
  tab: { paddingBottom: 16 },
  tabActive: { paddingBottom: 16 },
  tabText: { fontSize: 14, color: c.ink, fontWeight: '700' },
  tabMuted: { fontSize: 14, color: c.muted },
  underline: {
    height: 3,
    backgroundColor: c.ink,
    position: 'absolute',
    bottom: -1,
    left: 0,
    right: 0,
    borderRadius: 3,
  },
  sampleTag: {
    color: c.muted,
    fontSize: 10,
    backgroundColor: c.stone,
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 6,
    marginBottom: 12,
  },
  card: {
    marginHorizontal: 18,
    marginTop: 14,
    backgroundColor: c.white,
    borderRadius: 21,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.line,
  },
  author: { flexDirection: 'row', padding: 14, gap: 10, alignItems: 'center' },
  name: { fontSize: 14, fontWeight: '700', color: c.ink },
  time: { fontSize: 10, color: c.muted },
  photo: { width: '100%', height: undefined, aspectRatio: 1.13 },
  body: { padding: 15 },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: c.pale,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 9,
    borderRadius: 7,
  },
  badgeText: { color: c.ink, fontSize: 11, fontWeight: '600' },
  badgeSample: { fontSize: 9, color: c.muted },
  reactions: { flexDirection: 'row', alignItems: 'center', gap: 22, marginTop: 5 },
  reaction: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44 },
  count: { fontSize: 12, color: c.ink },
  caption: { color: c.ink, fontSize: 13, lineHeight: 23, marginTop: 2 },
  category: { color: c.muted, fontSize: 11, marginTop: 10 },
  end: { textAlign: 'center', fontSize: 12, color: c.muted, paddingTop: 28 },
});
