import { useEffect, useState } from 'react';
import {
  AppState,
  Pressable,
  Text,
  View,
  StyleSheet,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';
import { Button, Icon, Photo } from './UI';
import { colors as c } from '../theme';

// No player and no video download until the user taps. Parent owns the one active video.
export function VideoPreview({
  poster,
  load,
  active,
  onPlay,
  onStop,
  style,
}: {
  poster: ImageSourcePropType;
  load: () => Promise<VideoSource>;
  active: boolean;
  onPlay: () => void;
  onStop: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      {active ? (
        <Playback load={load} onStop={onStop} />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="動画を再生（初期ミュート）"
          onPress={onPlay}
          style={{ flex: 1 }}
        >
          <Photo source={poster} style={StyleSheet.absoluteFill} watermark={false} />
          <View style={s.play}>
            <Icon name="play" color="white" size={30} />
            <Text style={s.label}>動画を再生</Text>
          </View>
        </Pressable>
      )}
    </View>
  );
}
function Playback({ load, onStop }: { load: () => Promise<VideoSource>; onStop: () => void }) {
  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.loop = false;
    p.staysActiveInBackground = false;
    p.showNowPlayingNotification = false;
  });
  const [error, setError] = useState(''),
    [muted, setMuted] = useState(true),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const status = player.addListener('statusChange', (e) => {
      if (alive && e.status === 'error') {
        setLoading(false);
        setError('動画を再生できませんでした。閉じて再試行してください。');
      }
    });
    void (async () => {
      try {
        const source = await load();
        if (!alive) return;
        await player.replaceAsync(source);
        if (alive) {
          player.play();
          setLoading(false);
        }
      } catch {
        if (alive) {
          setLoading(false);
          setError('動画を読み込めませんでした。閉じて再試行してください。');
        }
      }
    })();
    const background = AppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        player.pause();
        onStop();
      }
    });
    // A media grant lasts 120 seconds. Drop decoded buffers before expiry and refresh on next tap.
    const expiry = setTimeout(onStop, 110_000);
    return () => {
      alive = false;
      clearTimeout(expiry);
      status.remove();
      background.remove();
    };
  }, [player]);
  return (
    <View style={{ flex: 1, backgroundColor: '#071A15' }}>
      <VideoView
        player={player}
        nativeControls
        contentFit="contain"
        fullscreenOptions={{ enable: false }}
        allowsPictureInPicture={false}
        style={{ flex: 1 }}
        accessibilityLabel="撮影した動画"
      />
      {(loading || error) && (
        <View style={s.play}>
          <Text style={s.label}>{error || '動画を読み込み中…'}</Text>
        </View>
      )}
      <View style={s.controls}>
        <Button
          secondary
          icon={muted ? 'volume-x' : 'volume-2'}
          onPress={() => {
            player.muted = !muted;
            setMuted(!muted);
          }}
        >
          {muted ? '音声をオン' : 'ミュート'}
        </Button>
        <Button secondary icon="x" onPress={onStop}>
          閉じる
        </Button>
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  play: {
    position: 'absolute',
    top: '40%',
    alignSelf: 'center',
    borderRadius: 24,
    backgroundColor: '#0F2C23CC',
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  label: { color: 'white', fontSize: 12 },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    padding: 8,
    backgroundColor: c.pale,
  },
});
