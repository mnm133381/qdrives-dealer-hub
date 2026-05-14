import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, TouchableOpacity, Image, RefreshControl, FlatList, Animated, Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useRouter, useFocusEffect } from 'expo-router';
import { Bell, Activity, TrendingUp, ShieldCheck, ChevronRight, Search, BadgeCheck, Lock, Zap, Filter, Inbox } from 'lucide-react-native';
import { firstCarImage } from '../../src/imageUri';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, formatINR, maskRegNo, radii, useTabBottomPad } from '../../src/theme';
import { useAuth } from '../../src/auth';
import { PendingApprovalCard } from '../../src/components/PendingApprovalCard';
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
  const tabPad = useTabBottomPad();
  const { dealer } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [pulse, setPulse] = useState<any>(null);
  const [activity, setActivity] = useState<any[]>([]);
  const [auctions, setAuctions] = useState<any[]>([]);
  const [activeFilter, setActiveFilter] = useState('all');
  const [loaded, setLoaded] = useState(false);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      // Single source of truth: /auctions returns ONLY the marketplace
      // dataset (post-Phase 2C filter). All counts and aggregates derive
      // from this list — no /market/pulse round-trip — so the search bar,
      // pulse strip, and inventory list can never disagree.
      const [s, all, act, uc] = await Promise.all([
        api.dashboard().catch(() => null),
        api.auctions().catch(() => []),
        api.networkActivity().catch(() => []),
        api.unreadCount().catch(() => ({ unread: 0 })),
      ]);
      setStats(s);
      setActivity(act as any[]);
      const list = (all as any[]) || [];
      // Hard filter: only live + upcoming surface in the dealer marketplace.
      // Backend already excludes archived/withdrawn/settled/dispute, but we
      // belt-and-brace to avoid any future leak.
      const visible = list.filter((a) => a.status === 'live' || a.status === 'upcoming');
      setAuctions(visible);
      // Pulse derived from the same list — guarantees count consistency.
      const liveList = visible.filter((a) => a.status === 'live');
      const upcomingList = visible.filter((a) => a.status === 'upcoming');
      const liveVolume = liveList.reduce((sum, a) => sum + (a.current_bid || a.starting_bid || 0), 0);
      setPulse({ live: liveList.length, upcoming: upcomingList.length, live_volume_inr: liveVolume });
      setUnread(((uc as any)?.unread as number) || 0);
    } catch {}
    setLoaded(true);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const featured = auctions.find((a) => a.status === 'live');

  const matchFilter = (a: any): boolean => {
    if (activeFilter === 'all') return true;
    const car = a.car || {};
    const fuel = (car.fuel_type || '').toLowerCase();
    const model = `${car.make} ${car.model}`.toLowerCase();
    const price = a.current_bid || a.starting_bid || 0;
    if (activeFilter === 'diesel') return fuel === 'diesel';
    if (activeFilter === 'petrol') return fuel === 'petrol';
    if (activeFilter === 'suv') return /(xuv|fortuner|harrier|compass|tucson|xc60|glc|q5|carnival)/.test(model);
    if (activeFilter === 'sedan') return /(city|superb|5 series|camry|civic)/.test(model);
    if (activeFilter === 'budget') return price < 1500000;
    if (activeFilter === 'luxury') return price >= 3000000;
    return true;
  };
  const inventory = auctions.filter((a) => a !== featured).filter(matchFilter);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
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
          {unread > 0 && (
            <View style={styles.notifBadge}>
              <Text style={styles.notifBadgeText}>{unread > 9 ? '9+' : String(unread)}</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: tabPad }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* Live activity ticker */}
        <ActivityTicker items={activity} />

        {/* Search bar */}
        <TouchableOpacity onPress={() => router.push('/(tabs)/auctions')} style={styles.search} activeOpacity={0.8} testID="home-search">
          <Search size={15} color={colors.textMuted} />
          <Text style={styles.searchPlaceholder}>Browse {pulse?.live ?? 0} live · {pulse?.upcoming ?? 0} upcoming</Text>
          <View style={styles.searchKbd}><Text style={styles.searchKbdText}>BROWSE</Text></View>
        </TouchableOpacity>

        {/* Pending / Suspended dealer state — premium blocked-state card */}
        <PendingApprovalCard status={dealer?.status} />

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

        {/* Featured Live Auction — single TouchableOpacity primitive,
            press feedback via activeOpacity, navigates to the canonical
            dealer auction route. No Link, no Pressable, no fallbacks. */}
        {featured && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <View>
                <Text style={styles.sectionKicker}>FEATURED LIVE AUCTION</Text>
                <Text style={styles.sectionTitle}>Hottest deal right now</Text>
              </View>
              <TouchableOpacity
                onPress={() => router.push({ pathname: '/lot/[id]', params: { id: featured.id } } as any)}
                hitSlop={8}
                activeOpacity={0.7}
                testID="featured-open-link"
              >
                <Text style={styles.seeAll}>Open →</Text>
              </TouchableOpacity>
            </View>
            <FeaturedCard auction={featured} />
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

        {/* Inventory — empty-state intelligence:
             - if no auctions exist at all → "Marketplace is quiet"
             - if filter empties results → "No matches · reset filter"
             - if only the featured exists → "Featured above is the only live listing" */}
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
          {!loaded ? (
            <View style={styles.skelCard}><Text style={styles.skelText}>Loading inventory…</Text></View>
          ) : auctions.length === 0 ? (
            <View style={styles.emptyIntelligence} testID="inv-empty-no-data">
              <View style={styles.emptyIcon}><Inbox size={20} color={colors.textChrome} /></View>
              <Text style={styles.emptyTitle}>No active inventory on the floor right now</Text>
              <Text style={styles.emptyBody}>Fresh wholesale inventory is uploaded throughout the day. The next listings will appear here automatically.</Text>
            </View>
          ) : inventory.length === 0 && featured ? (
            <View style={styles.emptyIntelligence} testID="inv-empty-featured-only">
              <View style={styles.emptyIcon}><Zap size={20} color={colors.warning} /></View>
              <Text style={styles.emptyTitle}>One active listing — featured above</Text>
              <Text style={styles.emptyBody}>This is the only auction matching the marketplace filter right now. Tap the featured card to bid, or open the full Auctions tab for upcoming listings.</Text>
              <TouchableOpacity onPress={() => router.push('/(tabs)/auctions')} style={styles.emptyCta}>
                <Text style={styles.emptyCtaText}>OPEN AUCTIONS TAB →</Text>
              </TouchableOpacity>
            </View>
          ) : inventory.length === 0 ? (
            <View style={styles.emptyIntelligence} testID="inv-empty-filter">
              <View style={styles.emptyIcon}><Filter size={20} color={colors.textChrome} /></View>
              <Text style={styles.emptyTitle}>No matches for "{activeFilter}"</Text>
              <Text style={styles.emptyBody}>Clear the filter to see all live inventory or try a different category.</Text>
              <TouchableOpacity onPress={() => setActiveFilter('all')} style={styles.emptyCta} testID="inv-reset-filter">
                <Text style={styles.emptyCtaText}>RESET FILTER →</Text>
              </TouchableOpacity>
            </View>
          ) : inventory.slice(0, 5).map((a) => (
            <AuctionCard
              key={a.id}
              auction={a}
              testID={`auction-card-${a.id}`}
              onPress={() => router.push({ pathname: '/lot/[id]', params: { id: a.id } } as any)}
            />
          ))}
        </View>

        {/* Trust footer removed per ops policy — no commercial-guarantee
            copy on dealer surfaces (escrow/settlement timelines were
            promises we don't enforce in v1). RC-verified inventory is
            now signaled inline on each lot card instead. */}
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

/* ------------------------------------------------------------------ *
 * FeaturedCard — premium dealer-facing live auction tile.
 *
 * Architecture (P0 routing fix, 2026-05-07 r3):
 *   • Single TouchableOpacity wrapper — the simplest, most reliable
 *     React Native touch primitive. Works identically on iOS Expo Go,
 *     Android, and web. No Pressable, no Link, no nested-button HTML
 *     concerns, no SPA-history fallbacks. Just onPress → router.push.
 *   • Whole card is one tap target. The "BID NOW" chip is a styled
 *     <View> for visual affordance — tapping it triggers the same
 *     onPress as tapping anywhere else on the card. No nested
 *     interactives.
 *   • Decorative absolute layers (Image, gradients, top row, bottom
 *     content) carry pointerEvents="none" so they cannot intercept
 *     the tap on web.
 *   • activeOpacity={0.85} provides the press feedback (instant
 *     "tap registered" feel). On native we also fire a Medium haptic.
 *   • Routes to `/auction/{id}` — the canonical bid-execution
 *     surface (single source of truth, no duplicate dealer alias).
 * ------------------------------------------------------------------ */
function FeaturedCard({ auction }: { auction: any }) {
  const router = useRouter();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const endMs = auction.end_time ? new Date(auction.end_time).getTime() : 0;
  const timeLeft = Math.max(0, Math.floor((endMs - now) / 1000));
  const ending = timeLeft > 0 && timeLeft <= 60;
  const reserveMet = auction.reserve_price && (auction.current_bid || 0) >= auction.reserve_price;
  const noReserve = !auction.reserve_price;

  const pulse = useMemo(() => new Animated.Value(0), []);
  useEffect(() => {
    if (!ending) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: false }),
      Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [ending]);
  const glowOpacity = ending ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.7] }) : 0;

  const onTap = useCallback(() => {
    if (Platform.OS !== 'web') {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); } catch {}
    }
    router.push({ pathname: '/lot/[id]', params: { id: auction.id } } as any);
  }, [router, auction.id]);

  return (
    <TouchableOpacity
      onPress={onTap}
      activeOpacity={0.85}
      testID={`featured-auction-${auction.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open auction for ${auction.car?.year || ''} ${auction.car?.make || ''} ${auction.car?.model || ''}`}
      style={styles.featCard}
    >
      <Image source={{ uri: firstCarImage(auction.car?.images) }} style={[styles.featImage, { pointerEvents: 'none' }]} />
      <View style={[styles.featGradTop, { pointerEvents: 'none' }]} />
      <View style={[styles.featGradBottom, { pointerEvents: 'none' }]} />
      {ending && (
        <Animated.View style={[styles.featUrgencyGlow, { opacity: glowOpacity, pointerEvents: 'none' }]} />
      )}

      <View style={[styles.featTopRow, { pointerEvents: 'none' }]}>
        <View style={styles.liveBadge}>
          <LivePulse size={6} />
          <Text style={styles.liveBadgeText}>LIVE</Text>
        </View>
        <View style={[styles.featTimer, ending && styles.featTimerEnding]}>
          <Text style={[styles.featTimerLabel, ending && { color: colors.red }]}>{ending ? 'ENDING NOW' : 'ENDS IN'}</Text>
          <CountdownTimer endTime={auction.end_time} compact />
        </View>
      </View>

      <View style={[styles.featBottom, { pointerEvents: 'none' }]}>
        <View style={styles.featMetaRow}>
          <View style={styles.featRegPlate}>
            <Text style={styles.featRegText}>{maskRegNo(auction.car?.registration_number)}</Text>
          </View>
          <View style={[
            styles.featReservePill,
            reserveMet && styles.featReserveMet,
            noReserve && styles.featReserveNone,
          ]}>
            <Text style={[
              styles.featReserveText,
              reserveMet && { color: colors.success },
              noReserve && { color: colors.textChrome },
            ]}>
              {noReserve ? 'NO RESERVE' : reserveMet ? '✓ RESERVE MET' : 'BELOW RESERVE'}
            </Text>
          </View>
        </View>
        <Text style={styles.featTitle} numberOfLines={1}>{auction.car?.year} {auction.car?.make} {auction.car?.model}</Text>
        <Text style={styles.featVariant} numberOfLines={1}>
          {auction.car?.variant ? auction.car?.variant + ' · ' : ''}{(auction.car?.km_driven || 0).toLocaleString('en-IN')} km · {auction.car?.fuel_type}
        </Text>
        <View style={styles.featPriceRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.featPriceLabel}>CURRENT BID</Text>
            <Text style={styles.featPrice}>{formatINR(auction.current_bid)}</Text>
            <Text style={styles.featBids}>{auction.total_bids || 0} bids · {auction.interested_dealers || 0} watching</Text>
          </View>
          {/* BID NOW chip — visual CTA inside the same tap target. */}
          <View
            style={[styles.featCta, ending && { backgroundColor: colors.red }]}
            testID={`featured-bid-now-${auction.id}`}
          >
            <Text style={styles.featCtaText}>BID NOW</Text>
            <ChevronRight size={14} color="#fff" />
          </View>
        </View>
      </View>
    </TouchableOpacity>
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
  notifBadge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, paddingHorizontal: 4,
    borderRadius: 9, backgroundColor: colors.red, borderWidth: 2, borderColor: colors.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  notifBadgeText: { color: '#fff', fontSize: 10, fontWeight: '900' },

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

  /* featCardWrap is the relative container so the floating BID NOW
     button (which lives OUTSIDE the Pressable card region in DOM) can
     be absolutely positioned over the card without breaking nested-
     button hydration on web. */
  featCardWrap: { position: 'relative', marginHorizontal: 20, marginBottom: 28 },
  featCard: {
    height: 320,
    borderRadius: radii.xl, overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1, borderColor: colors.border,
  },
  featCardPressed: { transform: [{ scale: 0.985 }], opacity: 0.95 },
  featUrgencyGlow: {
    position: 'absolute', left: 0, right: 0, bottom: 0, height: 6,
    backgroundColor: colors.red,
  },
  featImage: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  featGradTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 100, backgroundColor: 'rgba(11,11,13,0.55)' },
  featGradBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 200, backgroundColor: 'rgba(11,11,13,0.85)' },
  featTopRow: { position: 'absolute', top: 16, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.red, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  liveBadgeText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  featTimer: { alignItems: 'flex-end', paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(11,11,13,0.65)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  featTimerEnding: { borderColor: 'rgba(185,28,28,0.7)', backgroundColor: 'rgba(185,28,28,0.18)' },
  featTimerLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 3 },

  featBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 18 },
  featMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  featRegPlate: { paddingHorizontal: 8, paddingVertical: 3, backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 5 },
  featRegText: { color: '#0B0B0D', fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  featReservePill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5,
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.55)',
    backgroundColor: 'rgba(245,158,11,0.10)',
  },
  featReserveMet: { borderColor: 'rgba(16,185,129,0.55)', backgroundColor: 'rgba(16,185,129,0.10)' },
  featReserveNone: { borderColor: colors.border, backgroundColor: 'rgba(0,0,0,0.45)' },
  featReserveText: { color: colors.warning, fontSize: 9, fontWeight: '900', letterSpacing: 1.0 },
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
  /* Floating BID NOW — absolutely positioned overlay anchored to bottom-
     right of featCard. Lives outside the Pressable card region in DOM
     so it can carry its own accessibilityRole="button" without
     producing a nested-button hydration error on web. zIndex above the
     gradients ensures it's always pickable. */
  featCtaFloat: {
    position: 'absolute', right: 18, bottom: 22,
    flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.red,
    paddingHorizontal: 16, paddingVertical: 11, borderRadius: 999,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12, elevation: 10,
    zIndex: 10,
  },
  featCtaText: { color: '#fff', fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },

  /* Empty-state intelligence — three variants:
     • no marketplace data at all     → skel-quiet
     • only featured exists           → featured-only callout
     • filter empties results         → reset-filter card */
  emptyIntelligence: {
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.lg, padding: 26, alignItems: 'center', marginBottom: 16,
    borderStyle: 'dashed',
    // Subtle ambient red glow — keeps empty state from feeling dead
    shadowColor: colors.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.10,
    shadowRadius: 18,
    elevation: 2,
  },
  emptyIcon: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bgDeep, borderWidth: 1, borderColor: 'rgba(255,30,45,0.18)', marginBottom: 14,
  },
  emptyTitle: { color: colors.textPrimary, fontSize: 14.5, fontWeight: '800', letterSpacing: -0.2, textAlign: 'center' },
  emptyBody: { color: colors.textChrome, fontSize: 12, fontWeight: '400', textAlign: 'center', marginTop: 8, marginBottom: 16, lineHeight: 18, opacity: 0.85, paddingHorizontal: 8 },
  emptyCta: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    backgroundColor: 'rgba(255,30,45,0.10)', borderWidth: 1, borderColor: 'rgba(255,30,45,0.45)',
  },
  emptyCtaText: { color: colors.red, fontSize: 11, fontWeight: '900', letterSpacing: 1.0 },

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
  skelCard: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 32, alignItems: 'center', marginBottom: 16 },
  skelText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
});
