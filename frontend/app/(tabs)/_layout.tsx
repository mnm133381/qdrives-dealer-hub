import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Tabs, Redirect } from 'expo-router';
import { Home, Gavel, Heart, User, ShoppingBag } from 'lucide-react-native';
import { colors } from '../../src/theme';
import { useAuth } from '../../src/auth';
import { FloatingNavTray } from '../../src/components/FloatingNavTray';

/**
 * Dealer (bidder) marketplace shell.
 *
 * Tab navigation uses the custom <FloatingNavTray /> — a pull-up
 * floating pill that:
 *   - never collides with Android system gesture / 3-button nav
 *   - keeps a small visible affordance at all times
 *   - expands on tap or swipe-up to reveal all 5 nav targets
 *   - collapses only on user action (tap outside / swipe down /
 *     select a route) — no time-based auto-collapse
 *
 * `tabBarStyle.height: 0` plus `position: 'absolute'` tells React
 * Navigation NOT to reserve fixed space at the bottom; the floating
 * tray paints over screen content. Each screen continues to pad its
 * scroll content via `useTabBottomPad()` so list rows don't sit
 * underneath the pill.
 */
export default function TabsLayout() {
  const { dealer, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator color={colors.red} />
        <Text style={styles.loadingText}>Loading…</Text>
      </View>
    );
  }
  if (!dealer) return <Redirect href="/(auth)/login" />;
  if (!dealer.kyc_completed) return <Redirect href="/(auth)/kyc" />;
  if (['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(dealer.role as any)) return <Redirect href="/(admin)" />;

  return (
    <Tabs
      tabBar={(props) => <FloatingNavTray {...props} />}
      screenOptions={{
        headerShown: false,
        // No fixed reserved space; floating tray paints over content
        tabBarStyle: { height: 0, borderTopWidth: 0, position: 'absolute' },
        // Keep the labels available in route metadata for the tray
        tabBarLabelStyle: { fontSize: 0 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ({ color, size }) => <Home size={size - 2} color={color} strokeWidth={2} /> }} />
      <Tabs.Screen name="auctions" options={{ title: 'Auctions', tabBarIcon: ({ color, size }) => <Gavel size={size - 2} color={color} strokeWidth={2} /> }} />
      <Tabs.Screen name="purchases" options={{ title: 'Purchases', tabBarIcon: ({ color, size }) => <ShoppingBag size={size - 2} color={color} strokeWidth={2} /> }} />
      <Tabs.Screen name="watchlist" options={{ title: 'Watchlist', tabBarIcon: ({ color, size }) => <Heart size={size - 2} color={color} strokeWidth={2} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ color, size }) => <User size={size - 2} color={color} strokeWidth={2} /> }} />
      {/* Sell route still exists at /(tabs)/sell but is HIDDEN here for dealers; admins
         use the /(admin)/launch tab. The screen itself redirects non-admin users. */}
      <Tabs.Screen name="sell" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: colors.textMuted, fontSize: 12, letterSpacing: 1.5, fontWeight: '700' },
});
