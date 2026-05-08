/**
 * Seller vehicle tracking screen — sanitized read-only.
 *
 * Shows: vehicle info, current bid, bidder count, reserve progress,
 * countdown, settlement state + public audit timeline. NEVER shows
 * dealer identities.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, ShieldCheck, Users, Activity, Clock, Trophy, AlertOctagon,
  CheckCircle2,
} from 'lucide-react-native';
import { colors, radii, formatINRFull } from '../../../src/theme';
import { api } from '../../../src/api';
import { useToast } from '../../../src/toast';

function formatTime(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return '—'; }
}

function useCountdown(endIso?: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!endIso) return null;
  const end = new Date(endIso).getTime();
  const ms = Math.max(0, end - now);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function SellerVehicleDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<any>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.sellerVehicleDetail(id);
      setData(r);
    } catch (e: any) {
      if ((e.message || '').includes('401')) {
        router.replace('/(seller)/login' as any);
      } else {
        toast.show(e.message || 'Failed to load', 'error');
      }
    } finally { setLoading(false); }
  }, [id, router]);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 8000);
    return () => clearInterval(pollRef.current);
  }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };
  const a = data?.auction || {};
  const countdown = useCountdown(a.end_time);

  if (loading || !data) {
    return <View style={styles.loadWrap}><ActivityIndicator color={colors.red} /></View>;
  }

  const isLive = a.status === 'live';
  const isEnded = ['ended', 'ended_pending_payment', 'payment_received', 'delivered'].includes(a.status);
  const reservePct = Math.round((a.reserve_progress || 0) * 100);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ArrowLeft size={18} color={colors.textChrome} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>YOUR VEHICLE</Text>
          <Text style={styles.title} numberOfLines={1}>
            {data.year} {data.make} {data.model}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {(data.images && data.images[0]) ? (
          <Image source={{ uri: data.images[0] }} style={styles.hero} />
        ) : null}

        <View style={styles.regCard}>
          <Text style={styles.regLabel}>REGISTRATION</Text>
          <Text style={styles.regValue}>{data.registration_number || '—'}</Text>
          <View style={styles.regMeta}>
            <Text style={styles.regMetaText}>{data.variant} · {data.fuel_type} · {(data.km_driven || 0).toLocaleString('en-IN')} km</Text>
          </View>
        </View>

        {/* Live status strip */}
        <View style={[styles.stateStrip, isLive && styles.stateStripLive]}>
          <View style={[styles.dot, { backgroundColor: isLive ? colors.red : isEnded ? colors.success : colors.silver }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.stateLabel, { color: isLive ? colors.red : isEnded ? colors.success : colors.silver }]}>
              {isLive ? 'AUCTION LIVE' : isEnded ? 'AUCTION CLOSED' : (a.status || '').toUpperCase()}
            </Text>
            <Text style={styles.stateSub}>
              {isLive
                ? (countdown ? `Closes in ${countdown}` : 'In progress')
                : isEnded ? `Ended ${formatTime(a.end_time)}` : `Scheduled ${formatTime(a.start_time)}`}
            </Text>
          </View>
        </View>

        {/* Bid + bidder metrics */}
        <View style={styles.metricsRow}>
          <View style={styles.metricCard}>
            <Text style={styles.mLabel}>CURRENT BID</Text>
            <Text style={styles.mVal}>{formatINRFull(a.current_bid || 0)}</Text>
            <Text style={styles.mFoot}>{a.bid_count || 0} bids</Text>
          </View>
          <View style={styles.metricCard}>
            <Text style={styles.mLabel}>ACTIVE BIDDERS</Text>
            <View style={styles.bidderRow}>
              <Users size={16} color={colors.silver} />
              <Text style={styles.mVal}>{a.active_bidder_count || 0}</Text>
            </View>
            <Text style={styles.mFoot}>dealers tracking</Text>
          </View>
        </View>

        {/* Reserve progress */}
        <View style={styles.reserveCard}>
          <View style={styles.reserveHead}>
            <Text style={styles.sectionLabel}>RESERVE PROGRESS</Text>
            {a.reserve_met ? (
              <View style={styles.metPill}>
                <CheckCircle2 size={9} color={colors.success} />
                <Text style={[styles.metText, { color: colors.success }]}>RESERVE MET</Text>
              </View>
            ) : (
              <Text style={styles.metPctText}>{reservePct}% to reserve</Text>
            )}
          </View>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${a.reserve_met ? 100 : reservePct}%`, backgroundColor: a.reserve_met ? colors.success : colors.warning }]} />
          </View>
          <Text style={styles.reserveNote}>
            {a.reserve_met
              ? 'Reserve has been crossed. Sale will complete if the auction ends here.'
              : 'Bidders are below reserve. The sale only confirms once your reserve is crossed or you approve manually with operations.'}
          </Text>
        </View>

        {/* Settlement section (post-auction) */}
        {data.settlement && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>SETTLEMENT TIMELINE</Text>
            <View style={styles.settHead}>
              <ShieldCheck size={13} color={colors.success} />
              <Text style={styles.settHeadText}>
                Stage: <Text style={{ color: colors.textPrimary }}>
                  {(data.settlement.state || '').toUpperCase().replace(/_/g, ' ')}
                </Text>
              </Text>
            </View>
            <View style={styles.settGrid}>
              <View style={styles.settCell}>
                <Text style={styles.mLabel}>FINAL BID</Text>
                <Text style={styles.settVal}>{formatINRFull(data.settlement.winning_amount || 0)}</Text>
              </View>
              <View style={styles.settCell}>
                <Text style={styles.mLabel}>5% DEPOSIT</Text>
                <Text style={styles.settVal}>{formatINRFull(data.settlement.deposit_amount || 0)}</Text>
              </View>
            </View>
            {(data.settlement.audit_public || []).slice().reverse().map((ev: any, i: number) => (
              <View key={ev.id || i} style={styles.audit}>
                <View style={styles.auditDot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.auditAction}>{(ev.action || '').toUpperCase().replace(/_/g, ' ')}</Text>
                  <Text style={styles.auditMeta}>{formatTime(ev.ts)}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={styles.privacyNote}>
          <ShieldCheck size={11} color={colors.textMuted} />
          <Text style={styles.privacyText}>
            For dealer privacy, individual bidder names are never shown.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loadWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },

  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgDeep },
  backBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kicker: { color: colors.silver, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '900', marginTop: 2, letterSpacing: -0.3 },

  hero: { width: '100%', height: 220, borderRadius: radii.md, backgroundColor: '#000' },

  regCard: { padding: 14, marginTop: 14, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard },
  regLabel: { color: colors.silver, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  regValue: { color: colors.textPrimary, fontSize: 22, fontWeight: '900', marginTop: 4, letterSpacing: 1, fontVariant: ['tabular-nums'] },
  regMeta: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderColor: colors.border },
  regMetaText: { color: colors.textChrome, fontSize: 11.5, fontWeight: '500' },

  stateStrip: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, marginTop: 14, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  stateStripLive: { borderColor: 'rgba(255,30,45,0.40)', backgroundColor: 'rgba(255,30,45,0.05)' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  stateLabel: { fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  stateSub: { color: colors.textChrome, fontSize: 12, fontWeight: '500', marginTop: 3 },

  metricsRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  metricCard: { flex: 1, padding: 14, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  mLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  mVal: { color: colors.textPrimary, fontSize: 20, fontWeight: '900', marginTop: 6, letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  mFoot: { color: colors.textChrome, fontSize: 10.5, fontWeight: '500', marginTop: 4 },
  bidderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },

  reserveCard: { padding: 14, marginTop: 14, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  reserveHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  metPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.successBg, borderWidth: 1, borderColor: 'rgba(0,208,132,0.30)' },
  metText: { fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },
  metPctText: { color: colors.warning, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
  bar: { height: 6, marginTop: 10, borderRadius: 3, backgroundColor: colors.bg, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 3 },
  reserveNote: { color: colors.textChrome, fontSize: 11.5, fontWeight: '500', marginTop: 10, lineHeight: 17 },

  section: { marginTop: 18 },
  settHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, padding: 10, borderRadius: radii.md, backgroundColor: 'rgba(0,208,132,0.06)', borderWidth: 1, borderColor: 'rgba(0,208,132,0.30)' },
  settHeadText: { color: colors.textChrome, fontSize: 12, fontWeight: '700' },
  settGrid: { flexDirection: 'row', gap: 10, marginTop: 10 },
  settCell: { flex: 1, padding: 12, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  settVal: { color: colors.textPrimary, fontSize: 16, fontWeight: '900', marginTop: 5, fontVariant: ['tabular-nums'], letterSpacing: -0.3 },
  audit: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 10, marginTop: 6, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  auditDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6, backgroundColor: colors.success },
  auditAction: { color: colors.textPrimary, fontSize: 11.5, fontWeight: '900', letterSpacing: 0.4 },
  auditMeta: { color: colors.textMuted, fontSize: 10, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'] },

  privacyNote: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 18, justifyContent: 'center' },
  privacyText: { color: colors.textMuted, fontSize: 10.5, fontWeight: '500' },
});
