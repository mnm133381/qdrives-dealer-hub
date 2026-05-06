import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, RefreshControl, FlatList,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Bell, Activity, TrendingUp, ShieldCheck, ChevronRight, Search, BadgeCheck, Lock, Zap } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, formatINR, radii } from '../../src/theme';
import { useAuth } from '../../src/auth';
import { api } from '../../src/api';
import { AuctionCard } from '../../src/components/AuctionCard';
import { LivePulse } from '../../src/components/LivePulse';
import { CountdownTimer } from '../../src/components/CountdownTimer';
import { ActivityTicker } from '../../src/components/ActivityTicker';

const QUICK_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'suv', label: 'SUV' },
  { key: 'sedan', label: 'Sedan' },
  { key: 'diesel', label: 'Diesel' },
  { key: 'petrol', label: 'Petrol' },
  { key: 'budget', label: 'Under ₹15L' },
  { key: 'luxury', label: 'Luxury' },
];

export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dealer } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [pulse, setPulse] = useState<any>(null);
  const [activity, setActivity] = useState<any[]>([]);
  const [auctions, setAuctions] = useState<any[]>([]);
  const [activeFilter, setActiveFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const [s, p, act, live, all] = await Promise.all([
        api.dashboard().catch(() => null),
        api.marketPulse().catch(() => null),
        api.networkActivity().catch(() => []),
        api.auctions('live').catch(() => []),
        api.auctions().catch(() => []),
      ]);
      setStats(s);
      setPulse(p);
      setActivity(act as any[]);
      const upcoming = (all as any[]).filter((a) => a.status === 'upcoming');
      setAuctions([...(live as any[]), ...upcoming]);
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { const t = setInterval(load, 12000); return () => clearInterval(t); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const featured = auctions.find((a) => a.status === 'live');
  const inventory = auctions.filter((a) => a !== featured);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greet}>{greeting}</Text>
          <View style={styles.dealerRow}>
            <Text style={styles.dealerName} testID="home-dealer-name" numberOfLines={1}>
              {dealer?.dealership_name || dealer?.full_name || 'Dealer'}
            </Text>
            {dealer?.verified && <BadgeCheck size={16} color={colors.success} />}
          </View>
        </View>
        <TouchableOpacity onPress={() => router.push('/notifications')} style={styles.iconBtn} testID="home-notifications-btn">
          <Bell size={18} color={colors.textChrome} />
          <View style={styles.notifDot} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* Live activity ticker */}
        <ActivityTicker items={activity} />

        {/* Search bar */}
        <TouchableOpacity style={styles.search} activeOpacity={0.8}>
          <Search size={15} color={colors.textMuted} />
          <Text style={styles.searchPlaceholder}>Search by registration, make or model</Text>
          <View style={styles.searchKbd}><Text style={styles.searchKbdText}>⌘K</Text></View>
        </TouchableOpacity>

        {/* Market pulse strip */}
        <View style={styles.pulseStrip}>
          <View style={styles.pulseHeader}>
            <View style={styles.pulseLeft}>
              <LivePulse size={7} />
              <Text style={styles.pulseLive}>LIVE MARKET PULSE</Text>
            </View>
            <Text style={styles.pulseHint}>Updated just now</Text>
          </View>
          <View style={styles.pulseStats}>
            <PulseStat label="Live now" value={pulse?.live ?? '—'} accent={colors.red} />
            <View style={styles.pulseDivider} />
            <PulseStat label="Volume" value={formatINR(pulse?.live_volume_inr || 0)} />
            <View style={styles.pulseDivider} />
            <PulseStat label="Upcoming" value={pulse?.upcoming ?? '—'} />
          </View>
        </View>

        {/* Personal stats Grid */}
        <View style={styles.statsGrid}>
          <StatCard label="Trust" value={(stats?.trust_score ?? dealer?.trust_score ?? 4.5).toFixed(1)} suffix="/5" icon={<ShieldCheck size={13} color={colors.success} />} />
          <StatCard label="Bids" value={`${stats?.your_bids ?? 0}`} icon={<Activity size={13} color={colors.warning} />} />
          <StatCard label="Wins" value={`${stats?.your_wins ?? 0}`} icon={<TrendingUp size={13} color={colors.silver} />} />
        </View>

        {/* Featured Live Auction */}
        {featured && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <View>
                <Text style={styles.sectionKicker}>FEATURED LIVE AUCTION</Text>
                <Text style={styles.sectionTitle}>Hottest deal right now</Text>
              </View>
            </View>
            <TouchableOpacity activeOpacity={0.92} onPress={() => router.push(`/auction/${featured.id}`)} testID="featured-auction" style={styles.featCard}>
              <Image source={{ uri: featured.car?.images?.[0] }} style={styles.featImage} />
              <View style={styles.featGradTop} />
              <View style={styles.featGradBottom} />

              <View style={styles.featTopRow}>
                <View style={styles.liveBadge}>
                  <LivePulse size={6} />
                  <Text style={styles.liveBadgeText}>LIVE</Text>
                </View>
                <View style={styles.featTimer}>
                  <Text style={styles.featTimerLabel}>ENDS IN</Text>
                  <CountdownTimer endTime={featured.end_time} compact />
                </View>
              </View>

              <View style={styles.featBottom}>
                <View style={styles.featRegPlate}>
                  <Text style={styles.featRegText}>{featured.car?.registration_number}</Text>
                </View>
                <Text style={styles.featTitle} numberOfLines={1}>{featured.car?.year} {featured.car?.make} {featured.car?.model}</Text>
                <Text style={styles.featVariant} numberOfLines={1}>
                  {featured.car?.variant} · {(featured.car?.km_driven || 0).toLocaleString('en-IN')} km · {featured.car?.fuel_type}
                </Text>
                <View style={styles.featPriceRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.featPriceLabel}>CURRENT BID</Text>
                    <Text style={styles.featPrice}>{formatINR(featured.current_bid)}</Text>
                    <Text style={styles.featBids}>{featured.total_bids} bids · {featured.interested_dealers} watching</Text>
                  </View>
                  <View style={styles.featCta}>
                    <Text style={styles.featCtaText}>BID NOW</Text>
                    <ChevronRight size={14} color="#fff" />
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
            keyExtractor={(i) => i.key}
            contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <TouchableOpacity onPress={() => setActiveFilter(item.key)} style={[styles.filterPill, activeFilter === item.key && styles.filterPillActive]}>
                <Text style={[styles.filterText, activeFilter === item.key && styles.filterTextActive]}>{item.label}</Text>
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
              <Text style={styles.seeAll}>See all →</Text>
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

        {/* Trust footer */}
        <View style={styles.trustFooter}>
          <View style={styles.trustItem}>
            <Lock size={14} color={colors.silver} />
            <Text style={styles.trustItemText}>Bank-grade{'\n'}escrow</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <ShieldCheck size={14} color={colors.silver} />
            <Text style={styles.trustItemText}>Verified{'\n'}inventory</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Zap size={14} color={colors.silver} />
            <Text style={styles.trustItemText}>48-hr{'\n'}settlement</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function PulseStat({ label, value, accent }: { label: string; value: any; accent?: string }) {
  return (
    <View style={styles.pulseStat}>
      <Text style={[styles.pulseStatVal, accent && { color: accent }]}>{value}</Text>
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
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 18 },
  greet: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  dealerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  dealerName: { color: colors.textPrimary, fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  iconBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  notifDot: { position: 'absolute', top: 11, right: 11, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red, borderWidth: 1.5, borderColor: colors.bg },

  search: {
    marginHorizontal: 20, marginBottom: 16,
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 13, borderRadius: radii.md,
  },
  searchPlaceholder: { flex: 1, color: colors.textMuted, fontSize: 13, fontWeight: '500', letterSpacing: 0.2 },
  searchKbd: { paddingHorizontal: 6, paddingVertical: 2, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  searchKbdText: { color: colors.textMuted, fontSize: 9, fontWeight: '700' },

  pulseStrip: {
    marginHorizontal: 20, marginBottom: 18,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.lg, padding: 16,
  },
  pulseHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  pulseLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pulseLive: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.8 },
  pulseHint: { color: colors.textMuted, fontSize: 10, fontWeight: '600', letterSpacing: 0.4 },
  pulseStats: { flexDirection: 'row', alignItems: 'center' },
  pulseStat: { flex: 1, alignItems: 'flex-start' },
  pulseDivider: { width: StyleSheet.hairlineWidth, height: 32, backgroundColor: colors.border, marginHorizontal: 12 },
  pulseStatVal: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', letterSpacing: -0.4 },
  pulseStatLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.2, marginTop: 4 },

  statsGrid: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginBottom: 26 },
  statCard: { flex: 1, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 13 },
  statIconRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  statLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  statValue: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  statSuffix: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },

  section: { marginBottom: 8 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 20, marginBottom: 14 },
  sectionKicker: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.8 },
  sectionTitle: { color: colors.textPrimary, fontSize: 19, fontWeight: '800', marginTop: 5, letterSpacing: -0.4 },
  seeAll: { color: colors.textChrome, fontSize: 13, fontWeight: '700' },

  featCard: {
    marginHorizontal: 20, height: 320,
    borderRadius: radii.xl, overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 28,
  },
  featImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  featGradTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 100, backgroundColor: 'rgba(11,11,13,0.55)' },
  featGradBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 200, backgroundColor: 'rgba(11,11,13,0.85)' },
  featTopRow: { position: 'absolute', top: 16, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.red, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  liveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  featTimer: { alignItems: 'flex-end', paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(11,11,13,0.65)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  featTimerLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 3 },

  featBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 18 },
  featRegPlate: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 5, marginBottom: 10 },
  featRegText: { color: '#0B0B0D', fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  featTitle: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  featVariant: { color: colors.textChrome, fontSize: 12, marginTop: 4, fontWeight: '500' },
  featPriceRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 16 },
  featPriceLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.6 },
  featPrice: { color: colors.textPrimary, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginTop: 3 },
  featBids: { color: colors.textSecondary, fontSize: 11, marginTop: 4, fontWeight: '600' },
  featCta: {
    flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.red,
    paddingHorizontal: 16, paddingVertical: 11, borderRadius: 999,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12, elevation: 8,
  },
  featCtaText: { color: '#fff', fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },

  filtersWrap: { marginBottom: 16 },
  filterPill: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
  },
  filterPillActive: { backgroundColor: colors.red, borderColor: colors.red },
  filterText: { color: colors.textChrome, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  filterTextActive: { color: '#fff' },

  trustFooter: {
    marginHorizontal: 20, marginTop: 8, padding: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.lg,
  },
  trustItem: { flex: 1, alignItems: 'center', gap: 6 },
  trustItemText: { color: colors.textChrome, fontSize: 10, fontWeight: '700', textAlign: 'center', letterSpacing: 0.4, lineHeight: 14 },
  trustDivider: { width: StyleSheet.hairlineWidth, height: 32, backgroundColor: colors.border },
});
