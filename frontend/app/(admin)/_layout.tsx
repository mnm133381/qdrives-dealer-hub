import React from 'react';
import { View, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { Tabs, Redirect } from 'expo-router';
import { LayoutDashboard, Package, PlusCircle, Users, ShieldAlert, ScrollText, Truck } from 'lucide-react-native';
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
          height: Platform.OS === 'ios' ? 90 : 72,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 28 : 12,
        },
        tabBarActiveTintColor: colors.red,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 9.5, fontWeight: '900', letterSpacing: 0.6, textTransform: 'uppercase' },
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
      <Tabs.Screen name="settlement" options={{ title: 'Settle', tabBarIcon: ({ color, size }) => <Truck size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="security" options={{ title: 'Audit', tabBarIcon: ({ color, size }) => <ShieldAlert size={size - 2} color={color} strokeWidth={2.2} /> }} />
      <Tabs.Screen name="profile" options={{ title: 'Admin', tabBarIcon: ({ color, size }) => <ScrollText size={size - 2} color={color} strokeWidth={2.2} /> }} />
      {/* Broadcast is now reached via Ops dashboard quick-action; route remains. */}
      <Tabs.Screen name="broadcast" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  launchWrap: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
