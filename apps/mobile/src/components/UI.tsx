import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type ImageSourcePropType,
  type StyleProp,
} from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { PhotoWatermark } from './PhotoWatermark';
import { colors as c } from '../theme';
import type { ComponentProps, ReactNode } from 'react';

export function Photo({
  source,
  style,
  accessibilityLabel,
  watermark = true,
}: {
  source: ImageSourcePropType;
  style: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  watermark?: boolean;
}) {
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <Image
        source={source}
        accessibilityLabel={accessibilityLabel}
        resizeMode="cover"
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
      />
      {watermark && <PhotoWatermark />}
    </View>
  );
}

export type IconName = ComponentProps<typeof Feather>['name'];
export function Icon({
  name,
  size = 22,
  color = c.ink,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return <Feather name={name} size={size} color={color} />;
}
export function IconButton({
  name,
  label,
  disabled = false,
  onPress,
  color,
  style,
}: {
  name: IconName;
  label: string;
  disabled?: boolean;
  onPress: () => void;
  color?: string;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, style, pressed && { opacity: 0.5 }]}
    >
      <Icon name={name} color={color} />
    </Pressable>
  );
}
export function Button({
  children,
  onPress,
  secondary = false,
  disabled = false,
  icon,
}: {
  children: ReactNode;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: IconName;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.7 },
      ]}
    >
      {icon && <Icon name={icon} size={18} />}
      <Text style={styles.buttonText}>{children}</Text>
    </Pressable>
  );
}
export function Avatar({
  initial,
  color = c.pale,
  size = 42,
}: {
  initial: string;
  color?: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: c.ink, fontSize: size * 0.42, fontWeight: '600' }}>{initial}</Text>
    </View>
  );
}
export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={30} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{children}</Text>
    </View>
  );
}
export const styles = StyleSheet.create({
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  button: {
    backgroundColor: c.lime,
    borderRadius: 16,
    padding: 17,
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  secondary: { backgroundColor: c.stone },
  buttonText: { color: c.ink, fontSize: 15, fontWeight: '700' },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingVertical: 65, gap: 16 },
  emptyIcon: { backgroundColor: c.pale, padding: 24, borderRadius: 60 },
  emptyTitle: { color: c.ink, fontSize: 19, fontWeight: '600' },
  emptyCopy: { color: c.muted, fontSize: 14, lineHeight: 25, textAlign: 'center' },
});
