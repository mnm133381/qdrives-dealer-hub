import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ImageBackground, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, withRepeat, Easing } from 'react-native-reanimated';
import { colors } from '../src/theme';
import { useAuth } from '../src/auth';

export default function Splash() {
  const router = useRouter();
  const { loading, dealer } = useAuth();

  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.85);
  const shimmerX = useSharedValue(-200);
  const taglineOpacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
    scale.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });
    taglineOpacity.value = withDelay(500, withTiming(1, { duration: 700 }));
    shimmerX.value = withDelay(300, withRepeat(withTiming(200, { duration: 2200, easing: Easing.linear }), -1, false));
  }, [opacity, scale, taglineOpacity, shimmerX]);

  useEffect(() => {
    if (loading) return;
    // Splash auto-redirect MUST only fire when the user is actually on
    // the bare splash route ("/" or "/index"). On web, the same component
    // tree stays mounted across in-app router pushes; without this guard
    // the splash's setTimeout would yank dealers OUT of `/auction/[id]`
    // and back to `/(tabs)` 1.9s after any deep navigation, completely
    // breaking the BID NOW conversion flow.
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const path = window.location.pathname;
      if (path && path !== '/' && path !== '/index') {
        return;
      }
    }
    const t = setTimeout(() => {
      if (!dealer) router.replace('/(auth)' as any);
      else if (!dealer.kyc_completed) router.replace('/(auth)/kyc');
      else if (['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(dealer.role as any)) router.replace('/(admin)' as any);
      else router.replace('/(tabs)');
    }, 1900);
    return () => clearTimeout(t);
  }, [loading, dealer, router]);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shimmerX.value }],
  }));
  const taglineStyle = useAnimatedStyle(() => ({ opacity: taglineOpacity.value }));

  return (
    <View style={styles.container} testID="splash-screen">
      <ImageBackground
        source={{ uri: 'https://images.unsplash.com/photo-1771096095800-fe1f49993bf5?w=1200&q=80' }}
        style={styles.bgTexture}
        imageStyle={{ opacity: 0.08 }}
      >
        <View style={styles.center}>
          <Animated.View style={[styles.shieldWrap, logoStyle]}>
            <View style={styles.shield}>
              <Text style={styles.q}>Q</Text>
              <Animated.View style={[styles.shimmer, shimmerStyle]} />
            </View>
          </Animated.View>
          <Animated.Text style={[styles.brand, logoStyle]}>Q DRIVES</Animated.Text>
          <Animated.Text style={[styles.tagline, taglineStyle]}>
            India's premium dealer auction floor
          </Animated.Text>
        </View>
        <Animated.Text style={[styles.footer, taglineStyle]}>POWERED BY LIQUIDITY</Animated.Text>
      </ImageBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  bgTexture: { flex: 1, justifyContent: 'center' },
  center: { alignItems: 'center', paddingTop: 40 },
  shieldWrap: { marginBottom: 24 },
  shield: {
    width: 100, height: 116,
    backgroundColor: colors.bgCard,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: colors.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
    elevation: 12,
  },
  q: {
    color: colors.textPrimary,
    fontSize: 64,
    fontWeight: '900',
    letterSpacing: -2,
  },
  shimmer: {
    position: 'absolute',
    top: 0, bottom: 0,
    width: 60,
    backgroundColor: 'rgba(255,255,255,0.12)',
    transform: [{ skewX: '-20deg' }],
  },
  brand: {
    color: colors.textPrimary,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 8,
  },
  tagline: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 12,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  footer: {
    position: 'absolute',
    bottom: 50,
    alignSelf: 'center',
    color: colors.textMuted,
    fontSize: 10,
    letterSpacing: 4,
  },
});
