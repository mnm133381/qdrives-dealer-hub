/**
 * Operator Reputation Console — ranked dealer list.
 *
 * Bloomberg-style table:
 *   Score │ Tier │ Dealer │ Phone │ Restrictions │ Events
 *
 * Tappable rows route to /reputation/[id] for the drilldown.
 * Sort and tier filter live in a dense top control bar.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { ChevronRight, ShieldAlert, Eye, ShieldCheck } from 'lucide-react-native';
import { colors } from '../../src/theme';
import { AdminHeader } from '../../src/components/AdminHeader';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';

const TIERS = [
  { key: 'all', label: 'All' },
  { key: 'trusted', label: 'Trusted' },
  { key: 'stable', label: 'Stable' },
  { key: 'watch', label: 'Watch' },
  { key: 'risky', label: 'Risky' },
  { key: 'restricted', label: 'Restricted' },
];

const SORTS = [
  { key: 'score_asc', label: 'Score ↑' },
  { key: 'score_desc', label: 'Score ↓' },
];

export default function AdminReputation() {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tier, setTier] = useState<string>('all');
  const [sort, setSort] = useState<string>('score_asc');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.adminReputationList({
        sort,
        tier: tier === 'all' ? undefined : tier,
        limit: 200,
      });
      setRows(data || []);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load', 'error');
    } finally { setLoading(false); }
  }, [sort, tier, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [sort, tier, load]);

  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.trim().toLowerCase();
    return rows.filter(r =>
      (r.name || '').toLowerCase().includes(needle) ||
      (r.phone || '').includes(needle) ||
      (r.dealer_id || '').includes(needle)
    );
  }, [rows, q]);

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach(r => { const k = r.tier?.key || 'unknown'; m[k] = (m[k] || 0) + 1; });
    return m;
  }, [rows]);

  return (
    <View style={s.root}>
      <AdminHeader title="REPUTATION" subtitle="BUYER TRUST CONSOLE" />

      {/* Tier rail */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.tierRail}>
        {TIERS.map(t => {
          const c = t.key === 'all' ? rows.length : (counts[t.key] || 0);
          const active = tier === t.key;
          return (
            <TouchableOpacity key={t.key} onPress={() => setTier(t.key)}
              style={[s.tierChip, active && s.tierChipActive]}>
              <Text style={[s.tierChipText, active && s.tierChipTextActive]}>{t.label.toUpperCase()}</Text>
              <Text style={[s.tierChipCount, active && s.tierChipTextActive]}>{c}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Sort + search */}
      <View style={s.controlBar}>
        <View style={s.sortGroup}>
          {SORTS.map(o => (
            <TouchableOpacity key={o.key} onPress={() => setSort(o.key)}
              style={[s.sortBtn, sort === o.key && s.sortBtnActive]}>
              <Text style={[s.sortBtnText, sort === o.key && s.sortBtnTextActive]}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput value={q} onChangeText={setQ} placeholder="Search buyer"
          placeholderTextColor={colors.textMuted}
          style={s.search} returnKeyType="search" />
      </View>

      {loading && rows.length === 0 ? (
        <View style={s.center}><ActivityIndicator color={colors.red} /></View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            tintColor={colors.red} />}>
          {/* Header row */}
          <View style={[s.row, s.headRow]}>
            <Text style={[s.colScore, s.headTxt]}>SCORE</Text>
            <Text style={[s.colTier, s.headTxt]}>TIER</Text>
            <Text style={[s.colDealer, s.headTxt]}>BUYER</Text>
            <Text style={[s.colMeta, s.headTxt, { textAlign: 'right' }]}>EVENTS</Text>
          </View>
          {filtered.map(r => (
            <TouchableOpacity key={r.dealer_id}
              onPress={() => router.push({ pathname: '/reputation/[id]', params: { id: r.dealer_id } } as any)}
              activeOpacity={0.7} style={s.row}>
              <View style={s.colScore}>
                <Text style={[s.scoreNum, { color: r.tier?.color || colors.text }]}>{r.score}</Text>
              </View>
              <View style={s.colTier}>
                <View style={[s.tierPill, { backgroundColor: (r.tier?.color || '#666') + '22', borderColor: r.tier?.color || '#666' }]}>
                  <Text style={[s.tierPillTxt, { color: r.tier?.color || colors.text }]}>{(r.tier?.label || '').toUpperCase()}</Text>
                </View>
                {r.active_restrictions?.length > 0 && (
                  <View style={s.restrictRow}>
                    {r.active_restrictions.includes('suspended') && (
                      <View style={[s.restrictDot, { backgroundColor: colors.red }]} />
                    )}
                    {r.active_restrictions.includes('bidding_cooldown') && (
                      <View style={[s.restrictDot, { backgroundColor: '#F59E0B' }]} />
                    )}
                    {r.active_restrictions.includes('shadow_restricted') && (
                      <View style={[s.restrictDot, { backgroundColor: '#7C3AED' }]} />
                    )}
                  </View>
                )}
              </View>
              <View style={s.colDealer}>
                <Text style={s.name} numberOfLines={1}>{r.name || 'Unnamed'}</Text>
                <Text style={s.phone} numberOfLines={1}>{r.phone || r.dealer_id?.slice(0, 8)}</Text>
                {r.badges?.length > 0 && (
                  <View style={s.badgeRow}>
                    {r.badges.slice(0, 2).map((b: any) => (
                      <View key={b.key} style={[s.badge, { borderColor: b.color || '#444' }]}>
                        <Text style={[s.badgeTxt, { color: b.color || colors.textMuted }]}>{b.label.toUpperCase()}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
              <View style={[s.colMeta, { alignItems: 'flex-end' }]}>
                <Text style={s.metaNum}>{r.total_events ?? 0}</Text>
                <ChevronRight size={14} color={colors.textMuted} />
              </View>
            </TouchableOpacity>
          ))}
          {filtered.length === 0 && !loading && (
            <View style={s.center}><Text style={s.emptyTxt}>No buyers match the filter.</Text></View>
          )}
          <View style={{ height: 80 }} />
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { padding: 40, alignItems: 'center', justifyContent: 'center' },
  emptyTxt: { color: colors.textMuted, fontSize: 13 },
  tierRail: { paddingHorizontal: 12, paddingVertical: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  tierChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 6 },
  tierChipActive: { backgroundColor: colors.red + '22', borderColor: colors.red },
  tierChipText: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  tierChipTextActive: { color: colors.text },
  tierChipCount: { color: colors.textMuted, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  controlBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  sortGroup: { flexDirection: 'row', gap: 4 },
  sortBtn: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  sortBtnActive: { backgroundColor: colors.surface, borderColor: colors.text },
  sortBtnText: { color: colors.textMuted, fontSize: 10, fontWeight: '700' },
  sortBtnTextActive: { color: colors.text },
  search: { flex: 1, color: colors.text, fontSize: 12, paddingHorizontal: 8, paddingVertical: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 4, backgroundColor: colors.surface },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
  headRow: { backgroundColor: colors.surface, paddingVertical: 6 },
  headTxt: { color: colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
  colScore: { width: 56 },
  scoreNum: { fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'] },
  colTier: { width: 92, gap: 4 },
  tierPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3, borderWidth: 1, alignSelf: 'flex-start' },
  tierPillTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  restrictRow: { flexDirection: 'row', gap: 4 },
  restrictDot: { width: 6, height: 6, borderRadius: 3 },
  colDealer: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 13, fontWeight: '700' },
  phone: { color: colors.textMuted, fontSize: 10, fontVariant: ['tabular-nums'] },
  badgeRow: { flexDirection: 'row', gap: 4, marginTop: 2 },
  badge: { paddingHorizontal: 4, paddingVertical: 1, borderRadius: 2, borderWidth: 1 },
  badgeTxt: { fontSize: 8, fontWeight: '700', letterSpacing: 0.4 },
  colMeta: { width: 60, flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaNum: { color: colors.text, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
