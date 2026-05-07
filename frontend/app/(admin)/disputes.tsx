/**
 * Operator Dispute Queue — priority-sorted, SLA-aware.
 *
 * Sorted server-side by priority_score (escalation + SLA breach + base).
 * Mobile-first dense table: state pill | type | dealers | aging.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, AlertOctagon, Clock, Flame } from 'lucide-react-native';
import { colors } from '../../src/theme';
import { AdminHeader } from '../../src/components/AdminHeader';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';

const SEVERITY_COLOR: Record<string, string> = {
  ok: '#10B981',
  warning: '#FBBF24',
  breach: '#F59E0B',
  critical: '#DC2626',
  closed: '#6B7280',
};

const STATE_LABEL: Record<string, string> = {
  raised: 'RAISED',
  under_review: 'IN REVIEW',
  evidence_pending: 'EVID PENDING',
  decided: 'DECIDED',
  resolved: 'RESOLVED',
  withdrawn: 'WITHDRAWN',
};

export default function AdminDisputes() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all' | 'breached' | 'escalated'>('open');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [q, sm] = await Promise.all([
        api.adminDisputeQueue({ only_open: filter !== 'all' }),
        api.adminDisputeSummary(),
      ]);
      setItems(q || []);
      setSummary(sm);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load', 'error');
    } finally { setLoading(false); }
  }, [filter, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [filter, load]);

  const filtered = useMemo(() => {
    if (filter === 'breached') return items.filter(i => ['breach', 'critical'].includes(i.aging?.severity));
    if (filter === 'escalated') return items.filter(i => i.is_escalated);
    return items;
  }, [items, filter]);

  return (
    <View style={s.root}>
      <AdminHeader title="DISPUTES" subtitle="OPERATOR QUEUE" />

      {summary && (
        <View style={s.summary}>
          <SumCell label="OPEN" value={summary.open_total} />
          <SumCell label="BREACHED" value={summary.sla_breached} accent={colors.red} />
          <SumCell label="ESCALATED" value={summary.escalated} accent={'#F59E0B'} />
        </View>
      )}

      <View style={s.filters}>
        {([
          { k: 'open', l: 'OPEN' },
          { k: 'breached', l: 'BREACHED' },
          { k: 'escalated', l: 'ESCALATED' },
          { k: 'all', l: 'ALL' },
        ] as const).map(f => (
          <TouchableOpacity key={f.k} onPress={() => setFilter(f.k as any)}
            style={[s.fchip, filter === f.k && s.fchipActive]}>
            <Text style={[s.fchipTxt, filter === f.k && s.fchipTxtActive]}>{f.l}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && items.length === 0 ? (
        <View style={{ padding: 40, alignItems: 'center' }}><ActivityIndicator color={colors.red} /></View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            tintColor={colors.red} />}>
          {filtered.map((d: any) => (
            <TouchableOpacity key={d.id}
              onPress={() => router.push({ pathname: '/disputes/[id]', params: { id: d.id } } as any)}
              activeOpacity={0.7} style={s.row}>
              <View style={[s.severityRail, { backgroundColor: SEVERITY_COLOR[d.aging?.severity || 'ok'] }]} />
              <View style={{ flex: 1, padding: 10 }}>
                <View style={s.rowTop}>
                  <View style={[s.statePill, { borderColor: SEVERITY_COLOR[d.aging?.severity || 'ok'] }]}>
                    <Text style={[s.statePillTxt, { color: SEVERITY_COLOR[d.aging?.severity || 'ok'] }]}>{STATE_LABEL[d.state] || d.state.toUpperCase()}</Text>
                  </View>
                  {d.is_escalated && (
                    <View style={s.escBadge}>
                      <Flame size={10} color={colors.red} />
                      <Text style={s.escTxt}>ESCALATED</Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }} />
                  <View style={s.agingRow}>
                    <Clock size={11} color={colors.textMuted} />
                    <Text style={s.agingTxt}>{(d.aging?.elapsed_hours || 0).toFixed(1)}H</Text>
                  </View>
                </View>
                <Text style={s.title} numberOfLines={1}>{d.title}</Text>
                <Text style={s.typeLine} numberOfLines={1}>{d.type_label} · P{d.priority_score}</Text>
                <View style={s.partyRow}>
                  <PartyChip label="RAISER" rep={d.raiser_reputation} />
                  <Text style={s.vs}>vs</Text>
                  <PartyChip label="AGAINST" rep={d.against_reputation} />
                </View>
              </View>
              <ChevronRight size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
            </TouchableOpacity>
          ))}
          {filtered.length === 0 && (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={s.empty}>No disputes match the filter.</Text>
            </View>
          )}
          <View style={{ height: 80 }} />
        </ScrollView>
      )}
    </View>
  );
}

function PartyChip({ label, rep }: { label: string; rep?: any }) {
  if (!rep) return (
    <View style={s.partyChip}>
      <Text style={s.partyLbl}>{label}</Text>
      <Text style={s.partyMissing}>—</Text>
    </View>
  );
  const c = rep.tier?.color || colors.text;
  return (
    <View style={s.partyChip}>
      <Text style={s.partyLbl}>{label}</Text>
      <Text style={[s.partyScore, { color: c }]}>{rep.score}</Text>
      <Text style={[s.partyTier, { color: c }]}>{(rep.tier?.label || '').toUpperCase()}</Text>
      {rep.has_active_restriction && <View style={[s.partyRestrict, { backgroundColor: colors.red }]} />}
    </View>
  );
}

function SumCell({ label, value, accent }: any) {
  return (
    <View style={s.sumCell}>
      <Text style={s.sumLbl}>{label}</Text>
      <Text style={[s.sumVal, accent && { color: accent }]}>{value ?? '—'}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  summary: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  sumCell: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRightWidth: 1, borderRightColor: colors.border },
  sumLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  sumVal: { color: colors.text, fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
  filters: { flexDirection: 'row', paddingHorizontal: 10, paddingVertical: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  fchip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  fchipActive: { backgroundColor: colors.red + '22', borderColor: colors.red },
  fchipTxt: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  fchipTxtActive: { color: colors.text },
  row: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  severityRail: { width: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  statePill: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, borderWidth: 1 },
  statePillTxt: { fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  escBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 3, borderWidth: 1, borderColor: colors.red },
  escTxt: { color: colors.red, fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
  agingRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  agingTxt: { color: colors.textMuted, fontSize: 10, fontVariant: ['tabular-nums'], fontWeight: '700' },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  typeLine: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  partyRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 },
  partyChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 5, paddingVertical: 3, backgroundColor: colors.bg, borderRadius: 3, borderWidth: 1, borderColor: colors.border, flex: 1 },
  partyLbl: { color: colors.textMuted, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  partyScore: { fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  partyTier: { fontSize: 8, fontWeight: '800', letterSpacing: 0.4 },
  partyMissing: { color: colors.textMuted, fontSize: 10 },
  partyRestrict: { width: 6, height: 6, borderRadius: 3 },
  vs: { color: colors.textMuted, fontSize: 9, fontWeight: '700' },
  empty: { color: colors.textMuted, fontSize: 13 },
});
