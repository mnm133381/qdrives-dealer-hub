import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, Image,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShoppingBag, Trophy, Clock, ChevronRight, AlertCircle } from 'lucide-react-native';
import { colors, radii, formatINR, formatINRFull } from '../../src/theme';
import { api } from '../../src/api';

type Auction = any;

export default function Purchases() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'won' | 'active'>('active');
  const [data, setData] = useState<{ won: Auction[]; active: Auction[] }>({ won: [], active: [] });
  const [settlements, setSettlements] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [res, mySetts] = await Promise.all([
        api.purchases(),
        api.settlementsMine().catch(() => []),
      ]);
      setData(res as any);
      setSettlements(mySetts as any[] || []);
    } catch {}
    setLoaded(true);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const items = tab === 'won' ? data.won : data.active;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <View style={styles.header}>
        <Text style={styles.kicker}>YOUR PURCHASES</Text>
        <Text style={styles.title}>Wins & active bids</Text>
        <Text style={styles.sub}>Cars from Q Drives Inventory you've won or are currently leading.</Text>
      </View>

      <View style={styles.tabRow}>
        <TouchableOpacity
          onPress={() => setTab('active')}
          style={[styles.tab, tab === 'active' && styles.tabActive]}
          testID="purchases-tab-active"
        >
          <Clock size={14} color={tab === 'active' ? colors.red : colors.textChrome} />
          <Text style={[styles.tabText, tab === 'active' && styles.tabTextActive]}>
            Active · {data.active.length}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('won')}
          style={[styles.tab, tab === 'won' && styles.tabActive]}
          testID="purchases-tab-won"
        >
          <Trophy size={14} color={tab === 'won' ? colors.red : colors.textChrome} />
          <Text style={[styles.tabText, tab === 'won' && styles.tabTextActive]}>
            Won · {data.won.length}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {!loaded ? (
          <Text style={styles.loadingText}>Loading…</Text>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <ShoppingBag size={32} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>
              {tab === 'won' ? "You haven't won any auctions yet" : "You're not leading any live auctions"}
            </Text>
            <Text style={styles.emptySub}>
              {tab === 'won'
                ? 'Place winning bids on live auctions and your wins will appear here.'
                : 'Browse live auctions and bid to claim cars from Q Drives Inventory.'}
            </Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/auctions')} style={styles.browseBtn}>
              <Text style={styles.browseBtnText}>Browse live auctions</Text>
              <ChevronRight size={14} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : (
          items.map((a) => {
            const car = a.car || {};
            const reserveMet = a.reserve_met !== false;
            const settlement = tab === 'won' ? settlements.find((s) => s.auction_id === a.id) : null;
            return (
              <TouchableOpacity
                key={a.id}
                onPress={() => {
                  if (settlement) {
                    router.push({ pathname: '/won/[id]', params: { id: settlement.id } } as any);
                  } else {
                    router.push({ pathname: '/lot/[id]', params: { id: a.id } } as any);
                  }
                }}
                style={styles.card}
                activeOpacity={0.85}
              >
                <Image source={{ uri: car.images?.[0] || '' }} style={styles.thumb} />
                <View style={{ flex: 1, padding: 12 }}>
                  <View style={styles.statusRow}>
                    {tab === 'won' ? (
                      settlement ? (
                        <View style={[styles.badge, { backgroundColor: 'rgba(185,28,28,0.12)', borderColor: colors.red }]}>
                          <Trophy size={10} color={colors.red} />
                          <Text style={[styles.badgeText, { color: colors.red }]}>
                            {(settlement.state || '').toUpperCase().replace(/_/g, ' ')}
                          </Text>
                        </View>
                      ) : (
                        <View style={[styles.badge, reserveMet ? styles.badgeWon : styles.badgeWarn]}>
                          {reserveMet ? <Trophy size={10} color={colors.success} /> : <AlertCircle size={10} color={colors.warning} />}
                          <Text style={[styles.badgeText, { color: reserveMet ? colors.success : colors.warning }]}>
                            {reserveMet ? 'WON' : 'RESERVE NOT MET'}
                          </Text>
                        </View>
                      )
                    ) : (
                      <View style={[styles.badge, styles.badgeLive]}>
                        <View style={styles.liveDot} />
                        <Text style={[styles.badgeText, { color: colors.red }]}>LEADING · {a.seconds_remaining > 60 ? `${Math.round(a.seconds_remaining / 60)}m` : `${a.seconds_remaining}s`} LEFT</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.carTitle} numberOfLines={1}>{car.year} {car.make} {car.model}</Text>
                  <Text style={styles.carSub} numberOfLines={1}>{car.variant || ''} · {car.fuel_type} · {(car.km_driven || 0).toLocaleString('en-IN')} km</Text>
                  <View style={styles.priceRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.priceLabel}>{tab === 'won' ? 'FINAL BID' : 'YOUR BID'}</Text>
                      <Text style={styles.priceVal}>{formatINRFull(a.current_bid)}</Text>
                    </View>
                    <ChevronRight size={20} color={colors.textMuted} />
                  </View>
                </View>
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
  header: { paddingHorizontal: 20, marginBottom: 14 },
  kicker: { color: colors.red, fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', marginTop: 6, letterSpacing: -0.5 },
  sub: { color: colors.textSecondary, fontSize: 14, marginTop: 4, lineHeight: 20 },

  tabRow: { flexDirection: 'row', paddingHorizontal: 20, gap: 8, marginBottom: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 },
  tabActive: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: colors.red },
  tabText: { color: colors.textChrome, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  tabTextActive: { color: colors.red },

  loadingText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', marginTop: 50 },
  empty: { alignItems: 'center', paddingVertical: 60, gap: 12 },
  emptyTitle: { color: colors.textChrome, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  emptySub: { color: colors.textMuted, fontSize: 13, textAlign: 'center', maxWidth: 300, lineHeight: 18 },
  browseBtn: { marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.red, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  browseBtnText: { color: '#fff', fontSize: 12, fontWeight: '900', letterSpacing: 1 },

  card: {
    flexDirection: 'row',
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.lg, marginBottom: 14, overflow: 'hidden',
  },
  thumb: { width: 110, height: 110, backgroundColor: '#000' },
  statusRow: { flexDirection: 'row' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start' },
  badgeWon: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  badgeWarn: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' },
  badgeLive: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  badgeText: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.red },

  carTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', marginTop: 6, letterSpacing: -0.2 },
  carSub: { color: colors.textMuted, fontSize: 11, marginTop: 2, fontWeight: '500' },
  priceRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 8 },
  priceLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  priceVal: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', letterSpacing: -0.3, marginTop: 2 },
});
