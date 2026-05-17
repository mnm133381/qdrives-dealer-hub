/**
 * Global 404 catch-all. Expo-router renders this for any URL that
 * doesn't match a file in /app. Without this, an unknown path
 * (e.g. a stale share link from an older build, a typo, or a deep
 * link to a screen we've since renamed) renders a confusing
 * framework default. We give the viewer a clean error + a CTA back
 * to the marketplace.
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Link, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Compass } from 'lucide-react-native';
import { colors, radii } from '../src/theme';

export default function NotFound() {
  const insets = useSafeAreaInsets();
  return (
    <>
      <Stack.Screen options={{ headerShown: false, title: 'Not found' }} />
      <View style={[styles.root, { paddingTop: insets.top + 60 }]}>
        <View style={styles.icon}>
          <Compass size={28} color={colors.red} />
        </View>
        <Text style={styles.title}>This link isn't available</Text>
        <Text style={styles.body}>
          The page you tried to open may have moved or no longer exists. Head to the
          marketplace to find current listings.
        </Text>
        <Link href="/(tabs)" asChild>
          <TouchableOpacity style={styles.cta} testID="notfound-browse">
            <Text style={styles.ctaText}>Browse marketplace</Text>
          </TouchableOpacity>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', paddingHorizontal: 32 },
  icon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(220,38,38,0.08)', borderColor: 'rgba(220,38,38,0.35)', borderWidth: 1 },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '800', marginTop: 22, letterSpacing: -0.3, textAlign: 'center' },
  body:  { color: colors.textMuted, fontSize: 13, marginTop: 10, textAlign: 'center', lineHeight: 19 },
  cta:   { marginTop: 28, paddingHorizontal: 24, paddingVertical: 14, borderRadius: radii.md, backgroundColor: colors.red },
  ctaText: { color: '#fff', fontWeight: '800', fontSize: 13, letterSpacing: 0.3 },
});
