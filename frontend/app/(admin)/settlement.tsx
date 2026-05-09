/**
 * Settlement Operator Command Center — v2 (16-state, manual-control).
 *
 * Replaces the legacy auction-doc-status pipeline. This is the operator's
 * command center after auction completion. Q Drives is sole seller, every
 * state advances ONLY by explicit operator action with audit log.
 *
 * Layout:
 *   • Top KPI strip — open settlements, deposit-pending, payment-pending,
 *     refund-pending, delayed.
 *   • State filter rail — chips for each operationally meaningful state
 *     (8 buckets mapped from the 16 underlying states).
 *   • Queue list — dense rows with vehicle, dealer, value, age, current
 *     state, "next action" hint, navigates to /(admin)/settlements/[id].
 *   • Pull-to-refresh + 8s background poll while the screen is focused.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Banknote, ShieldCheck, MapPin, ClipboardCheck, Wallet, RotateCcw,
  AlertOctagon, CheckCircle2, ChevronRight, Truck, Pause,
} from 'lucide-react-native';
import { colors, radii, formatINR, useTabBottomPad } from '../../src/theme';
import { api } from '../../src/api';
import { AdminHeader } from '../../src/components/AdminHeader';
import { useToast } from '../../src/toast';

type Bucket = {
  key: string;
  label: string;
  states: string[];
  icon: any;
  tint: string;
  desc: string;
};

const BUCKETS: Bucket[] = [
  { key: 'all', label: 'ALL OPEN', states: [], icon: ClipboardCheck, tint: colors.silver, desc: 'Every non-terminal settlement' },
  { key: 'awaiting_operator_review', label: 'AWAITING REVIEW', states: ['awaiting_operator_review'], icon: ClipboardCheck, tint: colors.warning, desc: 'New wins to action' },
  { key: 'deposit_requested', label: 'DEPOSIT PENDING', states: ['deposit_requested'], icon: Banknote, tint: colors.warning, desc: 'Dealer to upload proof' },
  { key: 'deposit_under_verification', label: 'DEPOSIT SUBMITTED', states: ['deposit_under_verification'], icon: Banknote, tint: colors.warning, desc: 'Verify deposit proof' },
  { key: 'deposit_verified', label: 'DEPOSIT VERIFIED', states: ['deposit_verified'], icon: ShieldCheck, tint: colors.success, desc: 'Schedule a visit' },
  { key: 'visit_scheduled', label: 'VISIT SCHEDULED', states: ['visit_scheduled'], icon: MapPin, tint: colors.info, desc: 'Awaiting inspection' },
  { key: 'inspection_completed', label: 'POST-INSPECTION', states: ['inspection_completed'], icon: ClipboardCheck, tint: colors.info, desc: 'Refund or full payment' },
  { key: 'full_payment_requested', label: 'PAYMENT PENDING', states: ['full_payment_requested', 'full_payment_received', 'vehicle_delivered'], icon: Wallet, tint: colors.warning, desc: 'Final payment & handover' },
  { key: 'refund_pipeline', label: 'REFUND PENDING', states: ['refund_approved'], icon: RotateCcw, tint: colors.warning, desc: 'Process refund' },
  { key: 'flagged', label: 'DELAYED / NO-SHOW / DISPUTE', states: ['settlement_delayed', 'no_show_review', 'dispute'], icon: AlertOctagon, tint: colors.red, desc: 'Operator intervention' },
  { key: 'completed', label: 'COMPLETED', states: ['completed', 'refund_completed'], icon: CheckCircle2, tint: colors.success, desc: 'Terminal · audit-only' },
];

// State to "next operator action" hint
const STATE_HINT: Record<string, string> = {
  auction_won: 'auto-advancing',
  awaiting_operator_review: 'request 5% deposit',
  deposit_requested: 'awaiting dealer proof',
  deposit_under_verification: 'verify proof',
  deposit_verified: 'schedule visit',
  visit_scheduled: 'awaiting inspection',
  inspection_completed: 'choose: refund / full payment',
  refund_approved: 'mark refund completed',
  refund_completed: 'terminal · refunded',
  full_payment_requested: 'awaiting final payment',
  full_payment_received: 'mark vehicle delivered',
  vehicle_delivered: 'close deal',
  completed: 'terminal · closed',
  no_show_review: 'resume or close',
  settlement_delayed: 'investigate / resume',
  dispute: 'see disputes console',
};

const STATE_TINT: Record<string, string> = {
  auction_won: colors.silver,
  awaiting_operator_review: colors.warning,
  deposit_requested: colors.warning,
  deposit_under_verification: colors.warning,
  deposit_verified: colors.success,
  visit_scheduled: colors.info,
  inspection_completed: colors.info,
  refund_approved: colors.warning,
  refund_completed: colors.silver,
  full_payment_requested: colors.warning,
  full_payment_received: colors.success,
  vehicle_delivered: colors.success,
  completed: colors.success,
  no_show_review: colors.red,
  settlement_delayed: colors.red,
  dispute: colors.red,
};

export default function SettlementCenter() {
  const tabPad = useTabBottomPad();
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<{ by_state: Record<string, number>; buckets: Record<string, number>; total_open: number } | null>(null);
  const [activeBucket, setActiveBucket] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [queue, sum] = await Promise.all([
        api.adminSettlementsQueue(undefined, 200),
        api.adminSettlementsSummary(),
      ]);
      setItems(queue || []);
      setSummary(sum);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load settlements', 'error');
    } finally {
      setLoading(false); loadingRef.current = false;
    }
  }, []);

  useFocusEffect(useCallback(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const filtered = useMemo(() => {
    const bucket = BUCKETS.find((b) => b.key === activeBucket) || BUCKETS[0];
    if (bucket.key === 'all') {
      return items.filter((i) => !['completed', 'refund_completed'].includes(i.state));
    }
    return items.filter((i) => bucket.states.includes(i.state));
  }, [items, activeBucket]);

  const counts = summary?.by_state || {};

  return (
    <View style={styles.root}>
      <AdminHeader kicker="Settlement" title="Command Center" sub="Operator-controlled · 16-state · audit-attached" />

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: tabPad }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* KPI strip */}
        <View style={styles.kpiRow}>
          <Kpi label="OPEN" value={`${summary?.total_open ?? 0}`} icon={<ClipboardCheck size={13} color={colors.silver} />} />
          <Kpi label="DEPOSIT" value={`${summary?.buckets?.deposit_pending ?? 0}`} icon={<Banknote size={13} color={colors.warning} />} tint={(summary?.buckets?.deposit_pending ?? 0) > 0 ? colors.warning : undefined} />
          <Kpi label="PAYMENT" value={`${summary?.buckets?.payment_pending ?? 0}`} icon={<Wallet size={13} color={colors.warning} />} tint={(summary?.buckets?.payment_pending ?? 0) > 0 ? colors.warning : undefined} />
          <Kpi label="REFUND" value={`${summary?.buckets?.refund_pending ?? 0}`} icon={<RotateCcw size={13} color={colors.warning} />} tint={(summary?.buckets?.refund_pending ?? 0) > 0 ? colors.warning : undefined} />
          <Kpi label="DELAYED" value={`${summary?.buckets?.delayed ?? 0}`} icon={<AlertOctagon size={13} color={colors.red} />} tint={(summary?.buckets?.delayed ?? 0) > 0 ? colors.red : undefined} />
        </View>

        {/* Bucket filter rail */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {BUCKETS.map((b) => {
            const Icon = b.icon;
            const active = activeBucket === b.key;
            const count =
              b.key === 'all' ? (summary?.total_open ?? items.filter((i) => !['completed', 'refund_completed'].includes(i.state)).length)
                : b.states.reduce((s, k) => s + (counts[k] || 0), 0);
            return (
              <TouchableOpacity
                key={b.key} onPress={() => setActiveBucket(b.key)}
                style={[styles.chip, active && { backgroundColor: b.tint + '14', borderColor: b.tint }]}
                activeOpacity={0.85}
                testID={`bucket-${b.key}`}
              >
                <Icon size={12} color={active ? b.tint : colors.textChrome} />
                <Text style={[styles.chipLabel, active && { color: b.tint }]}>{b.label}</Text>
                <Text style={[styles.chipCount, active && { color: b.tint }]}>{count}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Bucket description */}
        <Text style={styles.bucketDesc}>
          {(BUCKETS.find((b) => b.key === activeBucket) || BUCKETS[0]).desc}
        </Text>

        {/* List */}
        {loading && items.length === 0 ? (
          <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>
        ) : filtered.length === 0 ? (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}><CheckCircle2 size={20} color={colors.success} /></View>
            <Text style={styles.emptyTitle}>Nothing to action here</Text>
            <Text style={styles.emptyBody}>The queue is clear for this bucket. Pull-to-refresh.</Text>
          </View>
        ) : (
          filtered.map((it) => (
            <SettlementRow
              key={it.id} row={it}
              onPress={() => router.push(`/(admin)/settlements/${it.id}` as any)}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

function SettlementRow({ row, onPress }: { row: any; onPress: () => void }) {
  const car = row.snapshot || {};
  const state = row.state as string;
  const tint = STATE_TINT[state] || colors.silver;
  const ageH = row.updated_at ? Math.max(0, (Date.now() - new Date(row.updated_at).getTime()) / 3600_000) : 0;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.row} testID={`settlement-row-${row.id}`}>
      <View style={[styles.rowState, { backgroundColor: tint + '14', borderColor: tint + '88' }]}>
        <View style={[styles.rowStateDot, { backgroundColor: tint }]} />
        <Text style={[styles.rowStateText, { color: tint }]}>{(state || '').toUpperCase().replace(/_/g, ' ')}</Text>
      </View>

      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {car.car_year || ''} {car.car_make || ''} {car.car_model || ''}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {car.car_reg || '—'} · DEAL {row.id?.slice(0, 8).toUpperCase()}
        </Text>

        <View style={styles.rowMeta}>
          <View style={styles.rowMetaCell}>
            <Text style={styles.rowMetaLabel}>WIN</Text>
            <Text style={styles.rowMetaVal}>{formatINR(row.winning_amount || 0)}</Text>
          </View>
          <View style={styles.rowMetaCell}>
            <Text style={styles.rowMetaLabel}>5% DEP</Text>
            <Text style={styles.rowMetaVal}>{formatINR(row.deposit_amount || 0)}</Text>
          </View>
          <View style={styles.rowMetaCell}>
            <Text style={styles.rowMetaLabel}>AGE</Text>
            <Text style={styles.rowMetaVal}>{ageH < 1 ? '<1h' : ageH < 24 ? `${Math.round(ageH)}h` : `${Math.floor(ageH / 24)}d`}</Text>
          </View>
        </View>

        <View style={styles.rowHintRow}>
          <Text style={[styles.rowHint, { color: tint }]} numberOfLines={1}>NEXT · {STATE_HINT[state] || '—'}</Text>
          <ChevronRight size={14} color={colors.textMuted} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

function Kpi({ label, value, icon, tint }: any) {
  return (
    <View style={[styles.kpi, tint && { borderColor: tint + '55', backgroundColor: tint + '0A' }]}>
      <View style={styles.kpiHead}>
        {icon}
        <Text style={[styles.kpiLabel, tint && { color: tint }]}>{label}</Text>
      </View>
      <Text style={styles.kpiVal}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, paddingTop: 6, paddingBottom: 80 },

  kpiRow: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  kpi: { flex: 1, padding: 9, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kpiHead: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  kpiLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.8 },
  kpiVal: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.4 },

  chipRow: { gap: 6, paddingBottom: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  chipLabel: { color: colors.textChrome, fontSize: 9.5, fontWeight: '900', letterSpacing: 0.8 },
  chipCount: { color: colors.textChrome, fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'], paddingLeft: 4, borderLeftWidth: 1, borderColor: colors.border, marginLeft: 4 },
  bucketDesc: { color: colors.textMuted, fontSize: 11, fontWeight: '700', marginTop: 8, marginBottom: 12, letterSpacing: 0.3 },

  loader: { paddingVertical: 30, alignItems: 'center' },
  emptyCard: { padding: 22, alignItems: 'center', borderRadius: radii.lg, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', marginTop: 8 },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
  emptyTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', letterSpacing: 0.4 },
  emptyBody: { color: colors.textChrome, fontSize: 11.5, fontWeight: '600', textAlign: 'center', marginTop: 4 },

  row: { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: 12, marginBottom: 10, overflow: 'hidden' },
  rowState: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1, alignSelf: 'flex-start', marginBottom: 8 },
  rowStateDot: { width: 6, height: 6, borderRadius: 3 },
  rowStateText: { fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  rowBody: {},
  rowTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  rowSub: { color: colors.textChrome, fontSize: 10.5, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  rowMeta: { flexDirection: 'row', gap: 12, marginTop: 10, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.border },
  rowMetaCell: { flex: 1 },
  rowMetaLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.8 },
  rowMetaVal: { color: colors.textPrimary, fontSize: 13, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'], letterSpacing: -0.2 },
  rowHintRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 9, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.border },
  rowHint: { fontSize: 10.5, fontWeight: '900', letterSpacing: 0.6 },
});
