import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Tabs, Redirect } from 'expo-router';
import { LayoutDashboard, Package, PlusCircle, Users, ShieldAlert, ScrollText, Truck } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../src/theme';
import { useAuth } from '../../src/auth';

/**
 * Admin / Operator Console Shell.
 *
 * Trading-terminal layout: dense ops-first navigation. The previous Notify
 * tab is now Audit (security feed). Broadcasts moved into the Ops dashboard
 * as a quick action.
 *
 * Multi-tier role gating: any of super_admin / admin / operations_admin /
 * inspection_admin can land here. Dealers are bounced to /(tabs).
 *
 * Bottom-inset handling — see /(tabs)/_layout.tsx for the rationale.
 */
export default function AdminLayout() {
  const { dealer, loading } = useAuth();
  const insets = useSafeAreaInsets();

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator color={colors.red} />
      </View>
    );
  }
  if (!dealer) return <Redirect href="/(auth)/login" />;
  const role = (dealer as any).role || 'dealer';
  const isOperator = ['super_admin', 'admin', 'operations_admin', 'inspection_admin'].includes(role);
  if (!isOperator) return <Redirect href="/(tabs)/" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: 'rgba(185,28,28,0.25)',
          borderTopWidth: 1,
          // Operator console tab bar is denser (smaller font, smaller
          // icons). 52dp base + insets.bottom keeps it tight on legacy
          // 3-button-nav devices and clears gesture nav cleanly.
          height: 52 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom + 6,
        },
        tabBarActiveTintColor: colors.red,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 9, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Ops', tabBarIcon: ({ color, size }) => <LayoutDashboard size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="inventory" options={{ title: 'Inventory', tabBarIcon: ({ color, size }) => <Package size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="launch" options={{
        title: 'List',
        tabBarLabel: 'List Car',
        tabBarIcon: () => (
          <View style={styles.launchWrap}><PlusCircle size={28} color={colors.red} fill={colors.red} strokeWidth={2.2} /></View>
        ),
      }} />
      <Tabs.Screen name="dealers" options={{ title: 'Dealers', tabBarIcon: ({ color, size }) => <Users size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="settlement" options={{ title: 'Settle', tabBarIcon: ({ color, size }) => <Truck size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="security" options={{ title: 'Audit', tabBarIcon: ({ color, size }) => <ShieldAlert size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Admin', tabBarIcon: ({ color, size }) => <ScrollText size={size - 2} color={color} strokeWidth={2.2} /> }} />
      {/* Dynamic detail routes — hidden from the tabbar; reachable via deep
          navigation from list screens. Without href:null they leak in as
          ghost tabs on web (Expo Router file-based discovery quirk). */}
      <Tabs.Screen name="auction/[id]" options={{ href: null }} />
      <Tabs.Screen name="dealer/[id]" options={{ href: null }} />
      <Tabs.Screen name="reputation" options={{ href: null }} />
      <Tabs.Screen name="reputation/[id]" options={{ href: null }} />
      <Tabs.Screen name="disputes" options={{ href: null }} />
      <Tabs.Screen name="disputes/[id]" options={{ href: null }} />
      <Tabs.Screen name="settlements/[id]" options={{ href: null }} />
      <Tabs.Screen name="sellers" options={{ href: null }} />
      {/* Broadcast is now reached via Ops dashboard quick-action; route remains. */}
      <Tabs.Screen name="broadcast" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  launchWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
