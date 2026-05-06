import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, RefreshControl, FlatList,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Bell, Activity, TrendingUp, ShieldCheck, ChevronRight, Search } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, formatINR, radii, spacing } from '../../src/theme';
import { useAuth } from '../../src/auth';
import { api } from '../../src/api';
import { AuctionCard } from '../../src/components/AuctionCard';
import { LivePulse } from '../../src/components/LivePulse';
import { CountdownTimer } from '../../src/components/CountdownTimer';

const QUICK_FILTERS = ['All', 'SUV', 'Sedan', 'Diesel', 'Petrol', '< ₹15L', 'Luxury'];

export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dealer } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [pulse, setPulse] = useState<any>(null);
  const [auctions, setAuctions] = useState<any[]>([]);
  const [activeFilter, setActiveFilter] = useState('All');

  const load = useCallback(async () => {
    try {
      const [s, p, live, all] = await Promise.all([
        api.dashboard().catch(() => null),
        api.marketPulse().catch(() => null),
        api.auctions('live').catch(() => []),
        api.auctions().catch(() => []),
      ]);
      setStats(s);
      setPulse(p);
      // featured = live first, then upcoming
      const upcoming = (all as any[]).filter((a) => a.status === 'upcoming');
      setAuctions([...(live as any[]), ...upcoming]);
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const featured = auctions.find((a) => a.status === 'live');
  const inventory = auctions.filter((a) => a !== featured);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greet}>Welcome back</Text>
          <Text style={styles.dealerName} testID="home-dealer-name" numberOfLines={1}>
            {dealer?.dealership_name || dealer?.full_name || 'Dealer'}
          </Text>
        </View>
        <TouchableOpacity onPress={() => router.push('/notifications')} style={styles.iconBtn} testID="home-notifications-btn">
          <Bell size={20} color={colors.textChrome} />
          <View style={styles.notifDot} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* Search bar */}
        <TouchableOpacity style={styles.search} activeOpacity={0.8}>
          <Search size={16} color={colors.textMuted} />
          <Text style={styles.searchPlaceholder}>Search by reg, make or model...</Text>
        </TouchableOpacity>

        {/* Market pulse strip */}
        <View style={styles.pulseStrip}>
          <View style={styles.pulseLeft}>
            <LivePulse size={8} />
            <Text style={styles.pulseLive}>LIVE MARKET</Text>
          </View>
          <View style={styles.pulseStats}>
            <PulseStat label="Live" value={pulse?.live ?? '—'} />
            <PulseStat label="Volume" value={formatINR(pulse?.live_volume_inr || 0)} />
            <PulseStat label="Upcoming" value={pulse?.upcoming ?? '—'} />
          </View>
        </View>

        {/* Stats Grid */}
        <View style={styles.statsGrid}>
          <StatCard label="Your Trust" value={(stats?.trust_score ?? dealer?.trust_score ?? 4.5).toFixed(1)} suffix="/5" icon={<ShieldCheck size={14} color={colors.success} />} />
          <StatCard label="Live Bids" value={`${stats?.your_bids ?? 0}`} icon={<Activity size={14} color={colors.warning} />} />
          <StatCard label="Wins" value={`${stats?.your_wins ?? 0}`} icon={<TrendingUp size={14} color={colors.silver} />} />
        </View>

        {/* Featured Live Auction */}
        {featured && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <View>
                <Text style={styles.sectionKicker}>FEATURED LIVE</Text>
                <Text style={styles.sectionTitle}>Hottest auction right now</Text>
              </View>
            </View>
            <TouchableOpacity activeOpacity={0.92} onPress={() => router.push(`/auction/${featured.id}`)} testID="featured-auction" style={styles.featCard}>
              <Image source={{ uri: featured.car?.images?.[0] }} style={styles.featImage} />
              <View style={styles.featOverlay} />
              <View style={styles.featBadgeRow}>
                <View style={styles.liveBadge}>
                  <LivePulse size={6} />
                  <Text style={styles.liveBadgeText}>LIVE</Text>
                </View>
                <CountdownTimer endTime={featured.end_time} compact />
              </View>
              <View style={styles.featBottom}>
                <Text style={styles.featTitle}>{featured.car?.year} {featured.car?.make} {featured.car?.model}</Text>
                <Text style={styles.featVariant}>{featured.car?.variant} · {featured.car?.km_driven?.toLocaleString('en-IN')} km</Text>
                <View style={styles.featPriceRow}>
                  <View>
                    <Text style={styles.featPriceLabel}>CURRENT BID</Text>
                    <Text style={styles.featPrice}>{formatINR(featured.current_bid)}</Text>
                  </View>
                  <View style={styles.featCta}>
                    <Text style={styles.featCtaText}>BID NOW</Text>
                    <ChevronRight size={16} color="#fff" />
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Quick filters */}
        <View style={styles.filtersWrap}>
          <FlatList
            horizontal
            data={QUICK_FILTERS}
            keyExtractor={(i) => i}
            contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <TouchableOpacity onPress={() => setActiveFilter(item)} style={[styles.filterPill, activeFilter === item && styles.filterPillActive]}>
                <Text style={[styles.filterText, activeFilter === item && styles.filterTextActive]}>{item}</Text>
              </TouchableOpacity>
            )}
          />
        </View>

        {/* Inventory */}
        <View style={[styles.section, { paddingHorizontal: 20 }]}>
          <View style={styles.sectionHead}>
            <View>
              <Text style={styles.sectionKicker}>RECOMMENDED FOR YOU</Text>
              <Text style={styles.sectionTitle}>Live inventory</Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/(tabs)/auctions')}>
              <Text style={styles.seeAll}>See all</Text>
            </TouchableOpacity>
          </View>
          {inventory.slice(0, 5).map((a) => (
            <AuctionCard
              key={a.id}
              auction={a}
              testID={`auction-card-${a.id}`}
              onPress={() => router.push(`/auction/${a.id}`)}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function PulseStat({ label, value }: { label: string; value: any }) {
  return (
    <View style={styles.pulseStat}>
      <Text style={styles.pulseStatVal}>{value}</Text>
      <Text style={styles.pulseStatLabel}>{label}</Text>
    </View>
  );
}

function StatCard({ label, value, suffix, icon }: any) {
  return (
    <View style={styles.statCard}>
      <View style={styles.statIconRow}>{icon}<Text style={styles.statLabel}>{label}</Text></View>
      <Text style={styles.statValue}>{value}<Text style={styles.statSuffix}>{suffix || ''}</Text></Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
  },
  greet: { color: colors.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  dealerName: { color: colors.textPrimary, fontSize: 19, fontWeight: '800', marginTop: 2, letterSpacing: -0.3 },
  iconBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  notifDot: { position: 'absolute', top: 12, right: 12, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red, borderWidth: 1.5, borderColor: colors.bg },

  search: {
    marginHorizontal: 20, marginBottom: 16,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: radii.md,
  },
  searchPlaceholder: { color: colors.textMuted, fontSize: 13 },

  pulseStrip: {
    marginHorizontal: 20, marginBottom: 16,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.lg, padding: 14,
  },
  pulseLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  pulseLive: { color: colors.red, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  pulseStats: { flexDirection: 'row', justifyContent: 'space-between' },
  pulseStat: { flex: 1 },
  pulseStatVal: { color: colors.textPrimary, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  pulseStatLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginTop: 2 },

  statsGrid: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, marginBottom: 24 },
  statCard: {
    flex: 1, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, padding: 12,
  },
  statIconRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 8 },
  statLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  statValue: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  statSuffix: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },

  section: { marginBottom: 8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 20, marginBottom: 14 },
  sectionKicker: { color: colors.red, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  sectionTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginTop: 4, letterSpacing: -0.3 },
  seeAll: { color: colors.textChrome, fontSize: 13, fontWeight: '700' },

  featCard: {
    marginHorizontal: 20, height: 280,
    borderRadius: radii.xl, overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 28,
  },
  featImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  featOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,11,13,0.55)' },
  featBadgeRow: { flexDirection: 'row', justifyContent: 'space-between', padding: 16 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.red, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  liveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  featBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 18 },
  featTitle: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  featVariant: { color: colors.textChrome, fontSize: 13, marginTop: 4 },
  featPriceRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 14 },
  featPriceLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.4 },
  featPrice: { color: colors.textPrimary, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginTop: 2 },
  featCta: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.red, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  featCtaText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 1 },

  filtersWrap: { marginBottom: 16 },
  filterPill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
  },
  filterPillActive: { backgroundColor: colors.red, borderColor: colors.red },
  filterText: { color: colors.textChrome, fontSize: 12, fontWeight: '700' },
  filterTextActive: { color: '#fff' },
});
