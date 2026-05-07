import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ImageBackground, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, Easing } from 'react-native-reanimated';
import { colors } from '../src/theme';
import { useAuth } from '../src/auth';
import { LogoLockup } from '../src/components/Logo';

export default function Splash() {
  const router = useRouter();
  const { loading, dealer } = useAuth();

  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.92);
  const taglineOpacity = useSharedValue(0);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.cubic) });
    scale.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });
    taglineOpacity.value = withDelay(500, withTiming(1, { duration: 700 }));
  }, [opacity, scale, taglineOpacity]);

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
  const taglineStyle = useAnimatedStyle(() => ({ opacity: taglineOpacity.value }));

  return (
    <View style={styles.container} testID="splash-screen">
      <ImageBackground
        source={{ uri: 'https://images.unsplash.com/photo-1771096095800-fe1f49993bf5?w=1200&q=80' }}
        style={styles.bgTexture}
        imageStyle={{ opacity: 0.04 }}
      >
        <View style={styles.center}>
          <Animated.View style={[styles.logoWrap, logoStyle]}>
            <LogoLockup width={240} />
          </Animated.View>
          <Animated.Text style={[styles.tagline, taglineStyle]}>
            Dealer Auction Platform
          </Animated.Text>
        </View>
        <View style={styles.loaderRow}>
          <View style={styles.loaderBar}>
            <Animated.View style={[styles.loaderFill, taglineStyle]} />
          </View>
        </View>
      </ImageBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  bgTexture: { flex: 1, justifyContent: 'center' },
  center: { alignItems: 'center', paddingTop: 30 },
  logoWrap: { marginBottom: 14 },
  tagline: {
    color: colors.silver,
    fontSize: 11,
    marginTop: 4,
    letterSpacing: 5,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  loaderRow: {
    position: 'absolute',
    bottom: 70,
    alignSelf: 'center',
    width: 96,
  },
  loaderBar: {
    height: 2,
    backgroundColor: colors.border,
    borderRadius: 1,
    overflow: 'hidden',
  },
  loaderFill: {
    height: '100%',
    backgroundColor: colors.red,
    width: '60%',
  },
});
