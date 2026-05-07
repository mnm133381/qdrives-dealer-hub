/**
 * Q Drives brand mark.
 *
 *   <LogoMark size={32} />            — shield-only icon (compact headers, app icon)
 *   <LogoLockupHorizontal height={36}/> — shield + "Q DRIVES" wordmark side-by-side
 *   <LogoLockup width={260} />        — full vertical lockup (splash only)
 *   <LogoWatermark size={220} />      — empty-state watermark, 12% opacity
 *
 * Source-of-truth: refined `qdrives-logo-full.png` + cropped shield variants.
 * Per brand rules: never recolor / stretch / distort. `resizeMode="contain"`.
 */
import React from 'react';
import { Image, View, Text, StyleSheet, ImageStyle, ViewStyle } from 'react-native';
import { colors } from '../theme';

const SHIELD = require('../../assets/brand/qdrives-shield.png');
const SHIELD_WM = require('../../assets/brand/qdrives-shield-watermark.png');
const FULL = require('../../assets/brand/qdrives-logo-full.png');

export function LogoMark({
  size = 32,
  style,
}: {
  size?: number;
  style?: ImageStyle;
}) {
  return (
    <Image
      source={SHIELD}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
      accessibilityLabel="Q Drives"
    />
  );
}

export function LogoLockup({
  width = 220,
  style,
}: {
  width?: number;
  style?: ViewStyle;
}) {
  // Source aspect ratio: 1536 x 1024 (≈3:2). Constrain by width.
  const height = Math.round((width * 1024) / 1536);
  return (
    <View style={[{ width, height, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Image
        source={FULL}
        style={{ width, height }}
        resizeMode="contain"
        accessibilityLabel="Q Drives — Dealer Auction Platform"
      />
    </View>
  );
}

/**
 * Compact horizontal lockup — preferred for chrome / login / portal usage.
 * Renders shield + wordmark in a tight row with restrained typography
 * matching the operator UI vocabulary. Avoids the "billboard" feel of the
 * full vertical lockup.
 */
export function LogoLockupHorizontal({
  height = 36,
  style,
  showSubline = false,
}: {
  height?: number;
  style?: ViewStyle;
  showSubline?: boolean;
}) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: Math.round(height * 0.32) }, style]}>
      <LogoMark size={height} />
      <View>
        <Text style={[styles.lockupWord, { fontSize: Math.round(height * 0.50), letterSpacing: Math.round(height * 0.10) }]}>
          Q DRIVES
        </Text>
        {showSubline && (
          <Text style={[styles.lockupSub, { fontSize: Math.max(8, Math.round(height * 0.20)) }]}>
            DEALER AUCTION PLATFORM
          </Text>
        )}
      </View>
    </View>
  );
}

export function LogoWatermark({
  size = 220,
  opacity = 0.10,
  style,
}: {
  size?: number;
  opacity?: number;
  style?: ImageStyle;
}) {
  return (
    <Image
      source={SHIELD_WM}
      style={[{ width: size, height: size, opacity }, style]}
      resizeMode="contain"
    />
  );
}

const styles = StyleSheet.create({
  lockupWord: {
    color: colors.textPrimary,
    fontWeight: '900',
    letterSpacing: 3,
  },
  lockupSub: {
    color: colors.silver,
    fontWeight: '800',
    letterSpacing: 1.6,
    marginTop: 2,
  },
});
