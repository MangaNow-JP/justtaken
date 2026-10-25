import { Text, View } from 'react-native';
import { locationSummary, type CaptureLocation } from '@justtaken/contracts';
import { appStyles as s } from '../appStyles';
import { Icon } from './UI';

export function CaptureLocationRecord({ location }: { location?: CaptureLocation }) {
  return (
    <View style={{ gap: 8, paddingVertical: 10 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Icon name="map-pin" size={17} />
        <Text style={s.sectionTitle}>撮影位置 · 自分のみ</Text>
      </View>
      <Text selectable style={s.small}>
        {locationSummary(location)}
      </Text>
      {location?.status === 'recorded' && (
        <>
          <Text style={s.small}>
            測位日時：{new Date(location.measuredAt).toLocaleString('ja-JP')}
          </Text>
          <Text style={s.small}>
            端末が取得した位置です。実際の撮影場所を保証するものではありません。原本・SNS・共有証明には含めません。
          </Text>
        </>
      )}
    </View>
  );
}
