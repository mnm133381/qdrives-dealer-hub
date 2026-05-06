import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { Tabs, Redirect } from 'expo-router';
import { LayoutDashboard, Package, PlusCircle, Users, Megaphone, ShieldCheck } from 'lucide-react-native';
import { colors } from '../../src/theme';
import { useAuth } from '../../src/auth';

/**
 * Admin Operations Shell.
 *
 * Distinct from the dealer (tabs) layout. Admin users land here directly
 * after login (see app/index.tsx + app/_layout.tsx redirects).
 *
 * Visual language: denser data UI, monospace-leaning numerics, persistent
 * "ADMIN OPS" status pill in each screen header. Dealer-facing copy is
 * removed entirely.
 */
export default function AdminLayout() {
  const { dealer, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator color={colors.red} />
      </View>
    );
  }
  if (!dealer) return <Redirect href="/(auth)/login" />;
  if (dealer.role !== 'admin') return <Redirect href="/(tabs)/" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: 'rgba(185,28,28,0.25)',
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 90 : 72,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 28 : 12,
        },
        tabBarActiveTintColor: colors.red,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 10, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Ops', tabBarIcon: ({ color, size }) => <LayoutDashboard size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="inventory" options={{ title: 'Inventory', tabBarIcon: ({ color, size }) => <Package size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="launch" options={{
        title: 'Launch',
        tabBarIcon: () => (
          <View style={styles.launchWrap}><PlusCircle size={28} color={colors.red} fill={colors.red} strokeWidth={2.2} /></View>
        ),
      }} />
      <Tabs.Screen name="dealers" options={{ title: 'Dealers', tabBarIcon: ({ color, size }) => <Users size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="broadcast" options={{ title: 'Notify', tabBarIcon: ({ color, size }) => <Megaphone size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Admin', tabBarIcon: ({ color, size }) => <ShieldCheck size={size - 2} color={color} strokeWidth={2.2} /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  launchWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
