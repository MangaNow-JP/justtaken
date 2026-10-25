import { Switch, Text, View } from 'react-native';
import { Photo } from './UI';
import { useWatermarkPreference } from '../preferences/WatermarkPreference';
import { appStyles as s } from '../appStyles';
import { colors as c } from '../theme';

export function WatermarkSettings() {
  const { enabled, ready, saving, error, update } = useWatermarkPreference();
  return (
    <View style={{ gap: 12, paddingVertical: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={s.sectionTitle}>写真にロゴを表示</Text>
          <Text style={s.small}>
            {!ready
              ? '読み込み中…'
              : saving
                ? '設定を保存中…'
                : enabled
                  ? 'ウォーターマーク：オン'
                  : 'ウォーターマーク：オフ'}
          </Text>
        </View>
        <Switch
          accessibilityLabel="写真にロゴを表示"
          accessibilityHint="この端末で表示する写真の右下にJustTakenロゴを重ねます"
          value={enabled}
          disabled={!ready || saving}
          onValueChange={(value) => void update(value)}
          trackColor={{ false: c.stone, true: c.lime }}
          thumbColor={c.ink}
        />
      </View>
      <Photo
        source={require('../../assets/coffee.jpg')}
        accessibilityLabel="ウォーターマーク設定のプレビュー"
        style={{ width: '100%', aspectRatio: 1.8, borderRadius: 12 }}
      />
      <Text style={s.small}>
        この端末の写真表示に適用します。ロゴは画面に重ねるため、原本・画質・撮影証明は変わりません。書き出す原本にはロゴを入れません。
      </Text>
      <Text style={s.small}>
        ロゴはブランド表示です。撮影認証の有無は、撮影記録から確認できます。
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: c.red, fontSize: 12 }}>
          {error}
        </Text>
      )}
    </View>
  );
}
