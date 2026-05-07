/**
 * Q Drives splash — premium dealer auction infrastructure.
 *
 * Layout matches the brand reference exactly:
 *   ┌─ ◢ ─────────────────────────────────── ◣ ─┐  diagonal corner accents
 *   │                                            │
 *   │              ╭ red ambient glow ╮          │
 *   │              │   shield logo    │          │
 *   │              ╰─────────────────╯           │
 *   │                                            │
 *   │                Q DRIVES                    │  wordmark
 *   │   ─ • VERIFIED INVENTORY • REAL-TIME BIDS • ─│  subline with rule+dot
 *   │                                            │
 *   │           ─── thin red loader ───          │
 *   └─ ◤ ─────────────────────────────────── ◥ ─┘
 *
 * Rules:
 *   • Bg is matte #050505 with a soft red radial glow centered on shield
 *   • 4 corner diagonal accents (red lines at ±45°)
 *   • No esports / cyberpunk effects, no shimmers
 *   • Logo upper-third for vertical balance
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Platform, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  useSharedValue, useAnimatedStyle, withTiming, withDelay,
  withRepeat, withSequence, Easing,
} from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { colors } from '../src/theme';
import { useAuth } from '../src/auth';
import { LogoMark } from '../src/components/Logo';

export default function Splash() {
  const router = useRouter();
  const { loading, dealer } = useAuth();

  const fade = useSharedValue(0);
  const lift = useSharedValue(8);
  const subFade = useSharedValue(0);
  const loadX = useSharedValue(-1);

  useEffect(() => {
    fade.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
    lift.value = withTiming(0, { duration: 900, easing: Easing.out(Easing.cubic) });
    subFade.value = withDelay(450, withTiming(1, { duration: 600 }));
    // Loader: indeterminate slide L→R, but slow & restrained (no flash)
    loadX.value = withDelay(
      300,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.cubic) }),
          withTiming(-1, { duration: 0 }),
        ),
        -1,
        false,
      ),
    );
  }, [fade, lift, subFade, loadX]);

  useEffect(() => {
    if (loading) return;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const path = window.location.pathname;
      if (path && path !== '/' && path !== '/index') return;
    }
    const t = setTimeout(() => {
      if (!dealer) router.replace('/(auth)' as any);
      else if (!dealer.kyc_completed) router.replace('/(auth)/kyc');
      else if (['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(dealer.role as any)) router.replace('/(admin)' as any);
      else router.replace('/(tabs)');
    }, 1900);
    return () => clearTimeout(t);
  }, [loading, dealer, router]);

  const heroStyle = useAnimatedStyle(() => ({
    opacity: fade.value,
    transform: [{ translateY: lift.value }],
  }));
  const subStyle = useAnimatedStyle(() => ({ opacity: subFade.value }));
  const loaderStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: loadX.value * 60 }],
    opacity: subFade.value,
  }));

  return (
    <View style={styles.root} testID="splash-screen">
      {/* Soft red ambient glow centered on shield using SVG radial gradient
          — produces a true radial bloom that fades to transparent. */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="42%" rx="38%" ry="38%" fx="50%" fy="42%">
            <Stop offset="0" stopColor="#D4141E" stopOpacity="0.32" />
            <Stop offset="0.35" stopColor="#D4141E" stopOpacity="0.12" />
            <Stop offset="0.7" stopColor="#D4141E" stopOpacity="0.03" />
            <Stop offset="1" stopColor="#D4141E" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#glow)" />
      </Svg>

      {/* Diagonal corner metallic accents (4 corners, ±45°) */}
      <View style={[styles.cornerLine, styles.cornerTopLeft]} pointerEvents="none" />
      <View style={[styles.cornerLine, styles.cornerTopLeftThin]} pointerEvents="none" />
      <View style={[styles.cornerLine, styles.cornerTopRight]} pointerEvents="none" />
      <View style={[styles.cornerLine, styles.cornerBottomLeft]} pointerEvents="none" />
      <View style={[styles.cornerLine, styles.cornerBottomRight]} pointerEvents="none" />
      <View style={[styles.cornerLine, styles.cornerBottomRightThin]} pointerEvents="none" />

      {/* Hero — composition pushed slightly above center */}
      <Animated.View style={[styles.hero, heroStyle]}>
        <LogoMark size={150} />
        <Text style={styles.wordmark}>Q DRIVES</Text>

        {/* Subline with rule+dot accents */}
        <Animated.View style={[styles.subRow, subStyle]}>
          <View style={styles.rule} />
          <View style={styles.subDot} />
          <Text style={styles.subText}>VERIFIED INVENTORY</Text>
          <View style={styles.subDotRed} />
          <Text style={styles.subText}>REAL-TIME BIDS</Text>
          <View style={styles.subDot} />
          <View style={styles.rule} />
        </Animated.View>
      </Animated.View>

      {/* Thin loader pinned to bottom */}
      <View style={styles.loaderWrap}>
        <View style={styles.loaderTrack}>
          <Animated.View style={[styles.loaderFill, loaderStyle]} />
        </View>
      </View>
    </View>
  );
}

const RED = colors.red;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050505', overflow: 'hidden' },

  // Corner accents — single rotated line each. Two stacked at TL/BR for
  // the parallel-stripe look in the reference (thicker + thinner).
  cornerLine: {
    position: 'absolute',
    width: 240, height: 1.2,
    backgroundColor: 'rgba(212,20,30,0.55)',
  },
  cornerTopLeft: {
    top: 110, left: -70,
    transform: [{ rotate: '-30deg' }],
  },
  cornerTopLeftThin: {
    top: 142, left: -90,
    height: 0.8,
    backgroundColor: 'rgba(212,20,30,0.30)',
    transform: [{ rotate: '-30deg' }],
  },
  cornerTopRight: {
    top: 78, right: -100,
    transform: [{ rotate: '-30deg' }],
    backgroundColor: 'rgba(160,160,170,0.18)',
  },
  cornerBottomLeft: {
    bottom: 130, left: -100,
    transform: [{ rotate: '-30deg' }],
    backgroundColor: 'rgba(160,160,170,0.18)',
  },
  cornerBottomRight: {
    bottom: 90, right: -70,
    transform: [{ rotate: '-30deg' }],
  },
  cornerBottomRightThin: {
    bottom: 60, right: -90,
    height: 0.8,
    backgroundColor: 'rgba(212,20,30,0.30)',
    transform: [{ rotate: '-30deg' }],
  },

  // Hero composition — slightly above visual center
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 120,   // pulls composition upward
  },
  wordmark: {
    color: '#EAEDF2',
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 8,
    marginTop: 12,
    textShadowColor: 'rgba(212,20,30,0.35)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 12,
  },
  rule: {
    width: 28,
    height: 1,
    backgroundColor: 'rgba(212,20,30,0.55)',
  },
  subDot: {
    width: 3, height: 3, borderRadius: 1.5,
    backgroundColor: 'rgba(234,237,242,0.45)',
  },
  subDotRed: {
    width: 4, height: 4, borderRadius: 2,
    backgroundColor: RED,
    shadowColor: RED, shadowOpacity: 0.6, shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  subText: {
    color: '#D6DAE2',
    fontSize: 9.5,
    fontWeight: '800',
    letterSpacing: 2,
  },

  // Bottom loader — minimal red bar with subtle glow
  loaderWrap: {
    position: 'absolute',
    left: 0, right: 0, bottom: 60,
    alignItems: 'center',
  },
  loaderTrack: {
    width: 120,
    height: 1.5,
    backgroundColor: 'rgba(60,60,70,0.45)',
    borderRadius: 1,
    overflow: 'hidden',
  },
  loaderFill: {
    height: '100%',
    width: 36,
    backgroundColor: RED,
    shadowColor: RED,
    shadowOpacity: 0.7,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    borderRadius: 1,
  },
});
