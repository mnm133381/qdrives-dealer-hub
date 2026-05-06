import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { AuctionCard } from '../../src/components/AuctionCard';

const TABS = [
  { key: 'live', label: 'Live' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'ended', label: 'Ended' },
];

export default function AuctionsTab() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'live' | 'upcoming' | 'ended'>('live');
  const [auctions, setAuctions] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [watch, setWatch] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const [list, w] = await Promise.all([
        api.auctions(tab),
        api.watchlist().catch(() => []),
      ]);
      setAuctions(list as any[]);
      const watchMap: Record<string, boolean> = {};
      (w as any[]).forEach((a) => { watchMap[a.id] = true; });
      setWatch(watchMap);
    } catch {}
  }, [tab]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggleWatch = async (id: string) => {
    const isWatched = watch[id];
    setWatch({ ...watch, [id]: !isWatched });
    try {
      if (isWatched) await api.removeWatch(id);
      else await api.addWatch(id);
    } catch {
      setWatch({ ...watch, [id]: isWatched });
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Auctions</Text>
        <Text style={styles.subtitle}>{auctions.length} {tab} {auctions.length === 1 ? 'auction' : 'auctions'}</Text>
      </View>

      <View style={styles.tabsRow}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            testID={`auctions-tab-${t.key}`}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key as any)}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {auctions.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No {tab} auctions yet</Text>
            <Text style={styles.emptySub}>Pull down to refresh</Text>
          </View>
        ) : (
          auctions.map((a) => (
            <AuctionCard
              key={a.id}
              auction={a}
              testID={`auction-card-${a.id}`}
              watching={!!watch[a.id]}
              onWatch={() => toggleWatch(a.id)}
              onPress={() => router.push(`/auction/${a.id}`)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, marginBottom: 12 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: colors.textMuted, fontSize: 13, fontWeight: '600', marginTop: 2 },
  tabsRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 20, paddingVertical: 12,
    backgroundColor: colors.bg,
  },
  tab: {
    flex: 1, paddingVertical: 10, alignItems: 'center',
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md,
  },
  tabActive: { backgroundColor: 'rgba(185,28,28,0.12)', borderColor: colors.red },
  tabText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: colors.red },
  empty: { paddingVertical: 60, alignItems: 'center' },
  emptyTitle: { color: colors.textChrome, fontSize: 16, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 13, marginTop: 6 },
});
