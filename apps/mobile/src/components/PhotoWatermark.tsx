import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
import { useWatermarkPreference } from '../preferences/WatermarkPreference';

// Branding is a removable display layer, never an authenticity badge or a file transform.
export function PhotoWatermark() {
  const { enabled, ready } = useWatermarkPreference();
  if (!ready || !enabled) return null;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      aria-hidden={true}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="photo-watermark"
      style={styles.mark}
    >
      <Svg width="100%" height="100%" viewBox="0 0 204 48">
        <G
          fill="none"
          stroke="white"
          strokeWidth={3.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <Path d="M4 15V9a5 5 0 0 1 5-5h7m17 0h6a5 5 0 0 1 5 5v7M4 33v6a5 5 0 0 0 5 5h7m17 0h6a5 5 0 0 0 5-5v-6M13 16h22M27 16v19M18 23v7a6 6 0 0 1-12 0" />
        </G>
        <Circle cx={37} cy={11} r={3} fill="#C6F56D" />
        <SvgText
          x={55}
          y={35}
          fontFamily="Helvetica"
          fontSize={30}
          fontWeight="800"
          letterSpacing={-1.2}
          fill="white"
        >
          JustTaken
        </SvgText>
      </Svg>
    </View>
  );
}
const styles = StyleSheet.create({
  mark: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: '31%',
    maxWidth: 126,
    minWidth: 64,
    aspectRatio: 4.25,
    backgroundColor: '#102E2833',
    borderRadius: 5,
    padding: 4,
    opacity: 0.9,
  },
});
