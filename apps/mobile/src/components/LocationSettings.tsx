import { Linking, Platform, Switch, Text, View } from 'react-native';
import { Button, Icon } from './UI';
import { useLocationPreference } from '../preferences/LocationPreference';
import { appStyles as s } from '../appStyles';
import { colors as c } from '../theme';

export function LocationSettings() {
  const { enabled, ready, saving, permission, supported, error, update } = useLocationPreference();
  const web = Platform.OS === 'web';
  return (
    <View style={{ gap: 12, paddingVertical: 18, borderBottomWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Icon name="map-pin" size={23} />
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={s.sectionTitle}>撮影時の位置情報（GPS）</Text>
          <Text style={s.small}>
            {!ready
              ? '読み込み中…'
              : saving
                ? '設定を保存中…'
                : enabled
                  ? web
                    ? 'オン · 表示プレビュー'
                    : permission
                      ? 'オン · 撮影中だけ取得'
                      : 'オン · 端末の許可を確認してください'
                  : 'オフ · 位置情報は取得しません'}
          </Text>
        </View>
        <Switch
          accessibilityLabel="撮影時の位置情報（GPS）"
          accessibilityHint="オンにすると、写真・動画の撮影開始時の位置を本人用の撮影記録に保存します"
          value={enabled}
          disabled={!ready || saving}
          onValueChange={(value) => void update(value)}
          trackColor={{ false: c.stone, true: c.lime }}
          thumbColor={c.ink}
        />
      </View>
      <Text style={s.small}>
        初期設定はオフです。オンにすると、カメラ画面を開いている間だけ位置を取得し、写真・動画の撮影開始時の位置と精度を記録します。撮影記録の送信時に、位置情報もサーバーへ保存します。
      </Text>
      <View style={[s.notice, { alignItems: 'flex-start' }]}>
        <Icon name="lock" size={17} />
        <Text style={s.noticeText}>
          位置は自分の撮影記録だけに表示。SNSの投稿・共有証明・原本ファイルには含めません。
        </Text>
      </View>
      <Text style={s.small}>
        測位できなくても撮影できます。おおよその位置の許可にも対応します。オフにしても過去の記録は変わりません。
      </Text>
      {web && (
        <Text style={s.small}>
          ブラウザでは設定の表示を試せます。実際のGPS取得はiPhone・Androidの専用アプリで行います。
        </Text>
      )}
      {!web && !supported && (
        <Text style={s.small}>GPSの利用には、対応したネイティブアプリのビルドが必要です。</Text>
      )}
      {!web && supported && !permission && (
        <Button
          secondary
          icon="settings"
          onPress={() => void Linking.openSettings().catch(() => {})}
        >
          端末の権限設定を開く
        </Button>
      )}
      {!!error && (
        <>
          <Text accessibilityRole="alert" style={{ color: c.red, fontSize: 12 }}>
            {error}
          </Text>
          {!enabled && (
            <Button secondary disabled={saving} onPress={() => void update(false)}>
              オフの設定を保存し直す
            </Button>
          )}
        </>
      )}
    </View>
  );
}
