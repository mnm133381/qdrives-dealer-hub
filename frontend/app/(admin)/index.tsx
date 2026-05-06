import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Activity, TrendingUp, Users, Package, Gauge, ArrowUpRight, Clock, AlertTriangle, ChevronRight, BadgeCheck } from 'lucide-react-native';
import { colors, radii, formatINR, formatINRFull } from '../../src/theme';
import { api } from '../../src/api';
import { AdminHeader } from '../../src/components/AdminHeader';

export default function AdminDashboard() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { const d = await api.adminDashboard(); setData(d); } catch {}
    setLoaded(true);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (!loaded) return <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>;

  return (
    <View style={styles.root}>
      <AdminHeader kicker="Operations dashboard" title="Marketplace controls" sub="Real-time visibility into auctions, dealers and inventory." />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 80 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}>

        {/* KPI strip */}
        <View style={styles.kpiRow}>
          <Kpi label="LIVE" value={data?.auctions?.live ?? 0} icon={<Activity size={14} color={colors.red} />} accent={colors.red} />
          <Kpi label="UPCOMING" value={data?.auctions?.upcoming ?? 0} icon={<Clock size={14} color={colors.warning} />} accent={colors.warning} />
          <Kpi label="CLOSED TODAY" value={data?.auctions?.ended_today ?? 0} icon={<TrendingUp size={14} color={colors.success} />} accent={colors.success} />
        </View>

        {/* GMV card */}
        <View style={styles.gmvCard}>
          <View style={styles.gmvHead}><Text style={styles.kicker}>GMV TODAY</Text><Gauge size={16} color={colors.red} /></View>
          <Text style={styles.gmvValue}>{formatINRFull(data?.activity?.gmv_today_inr || 0)}</Text>
          <View style={styles.gmvFoot}>
            <Pair label="Deals" value={`${data?.activity?.deals_today ?? 0}`} />
            <Pair label="Bids" value={`${data?.activity?.bids_today ?? 0}`} />
            <Pair label="Listings" value={`${data?.inventory?.listings_today ?? 0}`} />
          </View>
        </View>

        {/* Dealer pulse */}
        <Section title="Dealer network" right={(
          <TouchableOpacity onPress={() => router.push('/(admin)/dealers')} style={styles.linkRow}>
            <Text style={styles.linkText}>Manage</Text><ChevronRight size={14} color={colors.red} />
          </TouchableOpacity>
        )}>
          <View style={styles.cardsRow}>
            <MiniStat label="TOTAL" value={`${data?.dealers?.total ?? 0}`} sub="dealers" />
            <MiniStat label="VERIFIED" value={`${data?.dealers?.verified ?? 0}`} sub="approved" tint={colors.success} />
            <MiniStat label="PENDING" value={`${data?.dealers?.pending_verification ?? 0}`} sub="to review" tint={colors.warning} />
            <MiniStat label="SUSPENDED" value={`${data?.dealers?.suspended ?? 0}`} sub="locked" tint={colors.red} />
          </View>
        </Section>

        {/* Inventory */}
        <Section title="Inventory" right={(
          <TouchableOpacity onPress={() => router.push('/(admin)/inventory')} style={styles.linkRow}>
            <Text style={styles.linkText}>Open</Text><ChevronRight size={14} color={colors.red} />
          </TouchableOpacity>
        )}>
          <View style={styles.invCard}>
            <Package size={18} color={colors.red} />
            <View style={{ flex: 1 }}>
              <Text style={styles.invLabel}>{data?.inventory?.total ?? 0} vehicles in catalog</Text>
              <Text style={styles.invSub}>{data?.inventory?.listings_today ?? 0} new today · Q Drives Inventory</Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/(admin)/launch')} style={styles.launchBtn}>
              <Text style={styles.launchBtnText}>+ LAUNCH</Text>
            </TouchableOpacity>
          </View>
        </Section>

        {/* Top dealers */}
        {(data?.top_dealers || []).length > 0 && (
          <Section title="Top dealers by spend">
            {(data?.top_dealers || []).map((d: any, i: number) => (
              <View key={d.id} style={styles.topRow}>
                <View style={styles.topRank}><Text style={styles.topRankText}>#{i + 1}</Text></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.topName} numberOfLines={1}>{d.dealership_name || 'Dealer'}</Text>
                  <Text style={styles.topSub}>{d.city || ''} · {d.wins} wins</Text>
                </View>
                <Text style={styles.topSpend}>{formatINR(d.spend)}</Text>
              </View>
            ))}
          </Section>
        )}

        {/* Recent outcomes */}
        {(data?.recent_outcomes || []).length > 0 && (
          <Section title="Recent outcomes">
            {(data?.recent_outcomes || []).map((r: any) => (
              <TouchableOpacity key={r.id} onPress={() => router.push(`/auction/${r.id}`)} style={styles.outRow}>
                <View style={[styles.outBadge, r.reserve_met ? styles.outBadgeOk : styles.outBadgeWarn]}>
                  {r.reserve_met ? <BadgeCheck size={12} color={colors.success} /> : <AlertTriangle size={12} color={colors.warning} />}
                  <Text style={[styles.outBadgeText, { color: r.reserve_met ? colors.success : colors.warning }]}>
                    {r.reserve_met ? 'SOLD' : 'NO RESERVE'}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.outTitle} numberOfLines={1}>{(r.car?.year || '')} {(r.car?.make || '')} {(r.car?.model || '')}</Text>
                  <Text style={styles.outSub}>{r.car?.registration_number || ''}</Text>
                </View>
                <Text style={styles.outPrice}>{formatINR(r.final_bid)}</Text>
              </TouchableOpacity>
            ))}
          </Section>
        )}
      </ScrollView>
    </View>
  );
}

function Kpi({ label, value, icon, accent }: any) {
  return (
    <View style={[styles.kpi, { borderColor: accent + '55', backgroundColor: accent + '10' }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon}
        <Text style={[styles.kpiLabel, { color: accent }]}>{label}</Text>
      </View>
      <Text style={styles.kpiValue}>{value}</Text>
    </View>
  );
}
function Pair({ label, value }: any) { return <View><Text style={styles.pairValue}>{value}</Text><Text style={styles.pairLabel}>{label}</Text></View>; }
function MiniStat({ label, value, sub, tint }: any) { return <View style={[styles.miniStat, tint && { borderColor: tint + '55' }]}><Text style={[styles.miniLabel, tint && { color: tint }]}>{label}</Text><Text style={styles.miniValue}>{value}</Text><Text style={styles.miniSub}>{sub}</Text></View>; }
function Section({ title, right, children }: any) { return <View style={{ marginTop: 22 }}><View style={styles.sectionHead}><Text style={styles.sectionTitle}>{title}</Text>{right}</View>{children}</View>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  kicker: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  kpiRow: { flexDirection: 'row', gap: 8 },
  kpi: { flex: 1, padding: 12, borderRadius: radii.md, borderWidth: 1 },
  kpiLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  kpiValue: { color: colors.textPrimary, fontSize: 26, fontWeight: '900', marginTop: 6, letterSpacing: -0.6 },
  gmvCard: { marginTop: 16, padding: 16, borderRadius: radii.lg, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  gmvHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gmvValue: { color: colors.textPrimary, fontSize: 32, fontWeight: '900', marginTop: 6, letterSpacing: -0.8 },
  gmvFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  pairValue: { color: colors.textPrimary, fontSize: 16, fontWeight: '800' },
  pairLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.6, marginTop: 2 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  linkText: { color: colors.red, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  cardsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  miniStat: { flex: 1, minWidth: '47%', padding: 12, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  miniLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  miniValue: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', marginTop: 4, letterSpacing: -0.5 },
  miniSub: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2 },
  invCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  invLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '800' },
  invSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  launchBtn: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.red, borderRadius: 8 },
  launchBtnText: { color: '#fff', fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  topRank: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(185,28,28,0.10)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)' },
  topRankText: { color: colors.red, fontSize: 11, fontWeight: '900' },
  topName: { color: colors.textPrimary, fontSize: 13, fontWeight: '800' },
  topSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  topSpend: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  outRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  outBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start' },
  outBadgeOk: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  outBadgeWarn: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' },
  outBadgeText: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  outTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  outSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  outPrice: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
});
