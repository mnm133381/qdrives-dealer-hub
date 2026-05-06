import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { Tabs, Redirect } from 'expo-router';
import { Home, Gavel, PlusCircle, Heart, User } from 'lucide-react-native';
import { Platform } from 'react-native';
import { colors } from '../../src/theme';
import { useAuth } from '../../src/auth';

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

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 88 : 70,
          paddingTop: 8,
          paddingBottom: Platform.OS === 'ios' ? 28 : 12,
        },
        tabBarActiveTintColor: colors.red,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Home size={size - 2} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="auctions"
        options={{
          title: 'Auctions',
          tabBarIcon: ({ color, size }) => <Gavel size={size - 2} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="sell"
        options={{
          title: 'Sell',
          tabBarIcon: () => (
            <View style={styles.sellWrap}>
              <PlusCircle size={32} color={colors.red} fill={colors.red} strokeWidth={2} />
              <View style={styles.plusInner} />
            </View>
          ),
          tabBarLabel: 'Sell',
        }}
      />
      <Tabs.Screen
        name="watchlist"
        options={{
          title: 'Watchlist',
          tabBarIcon: ({ color, size }) => <Heart size={size - 2} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <User size={size - 2} color={color} strokeWidth={2} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: colors.textMuted, fontSize: 12, letterSpacing: 1.5, fontWeight: '700' },
  sellWrap: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  plusInner: { position: 'absolute', width: 14, height: 2, backgroundColor: '#fff', borderRadius: 1 },
});
