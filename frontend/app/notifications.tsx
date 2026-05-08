import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Bell, Trophy, AlertTriangle, ShieldCheck, Wallet, Clock4, Flag } from 'lucide-react-native';
import { colors, radii } from '../src/theme';
import { api } from '../src/api';

const ICON_MAP: Record<string, any> = {
  outbid: { icon: AlertTriangle, color: colors.red },
  win: { icon: Trophy, color: colors.success },
  payment: { icon: Wallet, color: colors.warning },
  verification: { icon: ShieldCheck, color: colors.success },
  ending_soon: { icon: Clock4, color: colors.warning },
  ended: { icon: Flag, color: colors.textChrome },
  auction_closed: { icon: Flag, color: colors.textChrome },
};

export default function Notifications() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const n = await api.notifications();
      setItems(n as any[]);
      api.markNotificationsRead().catch(() => {});
    } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="notifications-back">
          <ArrowLeft size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Notifications</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {items.length === 0 ? (
          <View style={styles.empty}>
            <Bell size={32} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>You're all caught up</Text>
            <Text style={styles.emptySub}>Bid alerts, payments and verification updates will appear here.</Text>
          </View>
        ) : (
          items.map((n) => {
            const conf = ICON_MAP[n.type] || ICON_MAP.outbid;
            const Icon = conf.icon;
            return (
              <TouchableOpacity
                key={n.id}
                onPress={() => {
                  // Silent funnel tracking — write 'opened' event for
                  // broadcast notifications. Best-effort; never blocks
                  // navigation or surfaces an error.
                  api.notificationOpen(n.id).catch(() => {});
                  if (n.auction_id) {
                    router.push({
                      pathname: '/lot/[id]',
                      params: { id: n.auction_id, fb: n.broadcast_id || '' },
                    } as any);
                  }
                }}
                style={[styles.notif, !n.read && styles.notifUnread]}
              >
                <View style={[styles.icon, { backgroundColor: `${conf.color}22`, borderColor: `${conf.color}55` }]}>
                  <Icon size={18} color={conf.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.notifTitle}>{n.title}</Text>
                  <Text style={styles.notifBody} numberOfLines={2}>{n.body}</Text>
                </View>
                {!n.read && <View style={styles.dot} />}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '800' },
  empty: { alignItems: 'center', paddingVertical: 80, gap: 12 },
  emptyTitle: { color: colors.textChrome, fontSize: 16, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 13, textAlign: 'center', maxWidth: 260, lineHeight: 18 },
  notif: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, padding: 14, marginBottom: 10,
  },
  notifUnread: { borderColor: 'rgba(185,28,28,0.3)', backgroundColor: 'rgba(185,28,28,0.04)' },
  icon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  notifTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  notifBody: { color: colors.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
});
