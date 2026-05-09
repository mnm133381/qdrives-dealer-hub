import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Heart } from 'lucide-react-native';
import { colors, useTabBottomPad } from '../../src/theme';
import { api } from '../../src/api';
import { AuctionCard } from '../../src/components/AuctionCard';

export default function Watchlist() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const tabPad = useTabBottomPad();
  const [items, setItems] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const w = await api.watchlist();
      setItems(w as any[]);
    } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const remove = async (id: string) => {
    setItems(items.filter((x) => x.id !== id));
    try { await api.removeWatch(id); } catch {}
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Watchlist</Text>
        <Text style={styles.sub}>{items.length} {items.length === 1 ? 'auction' : 'auctions'} you're tracking</Text>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: tabPad }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {items.length === 0 ? (
          <View style={styles.empty}>
            <Heart size={36} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>Your watchlist is empty</Text>
            <Text style={styles.emptySub}>Tap the heart on any auction to track it here in real-time.</Text>
          </View>
        ) : (
          items.map((a) => (
            <AuctionCard
              key={a.id}
              auction={a}
              testID={`watch-card-${a.id}`}
              watching
              onWatch={() => remove(a.id)}
              onPress={() => router.push({ pathname: '/lot/[id]', params: { id: a.id } } as any)}
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
  sub: { color: colors.textMuted, fontSize: 13, fontWeight: '600', marginTop: 2 },
  empty: { alignItems: 'center', paddingVertical: 80, gap: 12 },
  emptyTitle: { color: colors.textChrome, fontSize: 17, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 13, textAlign: 'center', maxWidth: 260, lineHeight: 18 },
});
