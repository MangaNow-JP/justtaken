import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Image, StyleSheet } from 'react-native';
import { colors } from '../theme';

export function LaunchAnimation() {
  const [visible, setVisible] = useState(true);
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(0.94)).current;
  const glow = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let alive = true;
    const finish = () => {
      if (alive) setVisible(false);
    };
    const reduced = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      if (enabled) finish();
    });
    // Always release the overlay, even if accessibility or animation callbacks fail.
    const fallback = setTimeout(finish, 1600);
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!alive) return;
        if (enabled) return finish();
        Animated.sequence([
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 420, useNativeDriver: true }),
            Animated.timing(glow, { toValue: 1, duration: 380, useNativeDriver: true }),
          ]),
          Animated.delay(220),
          Animated.timing(opacity, { toValue: 0, duration: 260, useNativeDriver: true }),
        ]).start(finish);
      })
      .catch(finish);
    return () => {
      alive = false;
      clearTimeout(fallback);
      reduced.remove();
      scale.stopAnimation();
      glow.stopAnimation();
      opacity.stopAnimation();
    };
  }, [opacity, scale, glow]);
  if (!visible) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        StyleSheet.absoluteFill,
        {
          zIndex: 100,
          backgroundColor: colors.background,
          alignItems: 'center',
          justifyContent: 'center',
          opacity,
        },
      ]}
    >
      <Animated.View style={{ transform: [{ scale }], alignItems: 'center', gap: 20 }}>
        <Image
          source={require('../../assets/justtaken-logo.png')}
          resizeMode="contain"
          style={{ width: 250, height: 84 }}
        />
        <Animated.View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.lime,
            opacity: glow,
          }}
        />
      </Animated.View>
    </Animated.View>
  );
}
