/**
 * Q Drives brand mark.
 *
 * Two surfaces:
 *   <LogoMark size={40} />     — shield-only icon (compact headers, app icon)
 *   <LogoLockup width={220} /> — full lockup: shield + "Q DRIVES" wordmark +
 *                                "DEALER AUCTION PLATFORM" subline
 *
 * Source-of-truth: /app/frontend/assets/brand/qdrives-logo-full.png and
 * the cropped shield qdrives-shield.png. Per brand rules, we never recolor,
 * stretch, or distort the logo — `resizeMode="contain"` always.
 */
import React from 'react';
import { Image, View, StyleSheet, ImageStyle, ViewStyle } from 'react-native';

// Import as require() so Metro inlines them as static assets — works in
// both Expo Go and web bundling.
const SHIELD = require('../../assets/brand/qdrives-shield.png');
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

export const _styles = StyleSheet.create({});
