import { useEffect, useState } from 'react';
import {
  AppState,
  Platform,
  Text,
  View,
  type ImageSourcePropType,
  type ImageURISource,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { captureModule } from '@justtaken/capture';
import { Button, Photo } from './UI';
import { PhotoWatermark } from './PhotoWatermark';
import { colors as c } from '../theme';

// The feed downloads only the preview. A fresh grant loads the stored original on demand.
export function OriginalPhoto({
  preview,
  load,
  active,
  onOpen,
  onClose,
  style,
}: {
  preview: ImageSourcePropType;
  load: () => Promise<ImageURISource>;
  active: boolean;
  onOpen: () => void;
  onClose: () => void;
  style: StyleProp<ViewStyle>;
}) {
  return (
    <View style={{ gap: 8 }}>
      {active ? (
        <Original load={load} onClose={onClose} style={style} />
      ) : (
        <Photo source={preview} style={style} />
      )}
      <Button secondary icon={active ? 'x' : 'maximize'} onPress={active ? onClose : onOpen}>
        {active ? 'プレビューに戻る' : '原本を表示'}
      </Button>
      {active && (
        <Text style={{ fontSize: 11, lineHeight: 18, color: c.muted }}>
          HDRの表示・RAWの現像は端末により異なります。保存・投稿する原本は変更しません。
        </Text>
      )}
    </View>
  );
}
function Original({
  load,
  onClose,
  style,
}: {
  load: () => Promise<ImageURISource>;
  onClose: () => void;
  style: StyleProp<ViewStyle>;
}) {
  const [source, setSource] = useState<ImageURISource | null>(null),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'android') void captureModule?.setHDRDisplay(true);
    let alive = true;
    void load()
      .then((value) => {
        if (alive) setSource(value);
      })
      .catch(() => {
        if (alive) setError('原画を読み込めませんでした。閉じて再試行してください。');
      });
    const timer = setTimeout(onClose, 110_000);
    const background = AppState.addEventListener('change', (state) => {
      if (state !== 'active') onClose();
    });
    return () => {
      alive = false;
      if (Platform.OS === 'android') void captureModule?.setHDRDisplay(false);
      clearTimeout(timer);
      background.remove();
    };
  }, []);
  return (
    <View style={[{ backgroundColor: c.pale, overflow: 'hidden' }, style]}>
      {source && (
        <Image
          source={source}
          contentFit="contain"
          preferHighDynamicRange
          cachePolicy="none"
          transition={0}
          style={{ width: '100%', height: '100%' }}
          accessibilityLabel="保存した原画"
          onLoad={() => setLoaded(true)}
          onError={() =>
            setError('この端末では原本を表示できません。原本は変換せず保存されています。')
          }
        />
      )}
      {loaded && !error && <PhotoWatermark />}
      {(!loaded || !!error) && (
        <View
          style={{
            position: 'absolute',
            inset: 0,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <Text style={{ color: c.ink }}>{error || '原画を読み込み中…'}</Text>
        </View>
      )}
    </View>
  );
}
