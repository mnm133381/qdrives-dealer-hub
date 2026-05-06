/**
 * Operator Security & Audit Console.
 *
 * Two segmented views:
 *  • AUDIT TRAIL — security-focused events from db.audit_logs (logins,
 *    denied access, allow-list mutations, status changes, max-bid changes,
 *    broadcasts, etc.).
 *  • DENIED LOGINS — last N denied OTP attempts (rolling 24h / all),
 *    surfaces repeat-offender phones for fraud detection.
 *
 * Trading-terminal aesthetic: dense, monospaced timestamps, color-coded
 * action types. No vanity charts.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, TextInput,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Search, ShieldAlert, ShieldCheck, Ban, UserPlus, UserMinus, Gavel,
  AlertOctagon, Clock, Filter, Megaphone, BadgeAlert, Activity,
} from 'lucide-react-native';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { AdminHeader } from '../../src/components/AdminHeader';

type Tab = 'audit' | 'denied';
type Window = '1' | '24' | 'all';

const ACTION_META: Record<string, { label: string; tint: string; icon: any }> = {
  dealer_login: { label: 'Dealer login', tint: colors.success, icon: ShieldCheck },
  operator_login: { label: 'Operator login', tint: colors.silver, icon: ShieldCheck },
  dealer_access_denied: { label: 'Dealer denied', tint: colors.red, icon: Ban },
  operator_access_denied: { label: 'Operator denied', tint: colors.red, icon: AlertOctagon },
  allow_list_add: { label: 'Allow-list +', tint: colors.success, icon: UserPlus },
  allow_list_update: { label: 'Allow-list edit', tint: colors.warning, icon: BadgeAlert },
  allow_list_revoke: { label: 'Allow-list revoke', tint: colors.red, icon: UserMinus },
  dealer_status_change: { label: 'Dealer status', tint: colors.warning, icon: Activity },
  max_bid_change: { label: 'Max bid changed', tint: colors.warning, icon: Gavel },
  auction_pause: { label: 'Auction paused', tint: colors.warning, icon: Clock },
  auction_cancel: { label: 'Auction cancelled', tint: colors.red, icon: Ban },
  auction_extend: { label: 'Auction extended', tint: colors.warning, icon: Clock },
  bid_cancel: { label: 'Bid cancelled', tint: colors.red, icon: Ban },
  admin_broadcast: { label: 'Broadcast sent', tint: colors.silver, icon: Megaphone },
  operator_promotion: { label: 'Operator promoted', tint: colors.success, icon: ShieldCheck },
};

export default function AdminSecurity() {
  const [tab, setTab] = useState<Tab>('audit');
  const [windowFilter, setWindowFilter] = useState<Window>('24');
  const [actionFilter, setActionFilter] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [audit, setAudit] = useState<{ items: any[]; total: number }>({ items: [], total: 0 });
  const [denied, setDenied] = useState<{ items: any[]; total_attempts: number; repeat_offenders: any[] }>({ items: [], total_attempts: 0, repeat_offenders: [] });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const since = windowFilter === 'all' ? undefined : windowFilter === '1' ? 1 : 24;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === 'audit') {
        const data = await api.adminAuditLogs({
          since_hours: since, limit: 100,
          action: actionFilter || undefined,
          q: q || undefined,
        });
        setAudit(data);
      } else {
        const data = await api.adminDeniedLogins(since);
        setDenied(data);
      }
    } catch {} finally { setLoading(false); }
  }, [tab, since, actionFilter, q]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  return (
    <View style={styles.root}>
      <AdminHeader
        kicker="Security · audit"
        title="Operator audit trail"
        sub="Permanent record of every privileged action and denied access attempt."
      />

      {/* Segmented tabs */}
      <View style={styles.segRow}>
        <SegBtn label="AUDIT TRAIL" active={tab === 'audit'} onPress={() => setTab('audit')} />
        <SegBtn label="DENIED LOGINS" active={tab === 'denied'} onPress={() => setTab('denied')} count={denied.total_attempts} />
      </View>

      {/* Time window filter */}
      <View style={styles.windowRow}>
        <Clock size={11} color={colors.textMuted} />
        <Text style={styles.windowLabel}>WINDOW</Text>
        {(['1', '24', 'all'] as Window[]).map((w) => (
          <TouchableOpacity key={w} onPress={() => setWindowFilter(w)} style={[styles.windowChip, windowFilter === w && styles.windowChipActive]}>
            <Text style={[styles.windowChipText, windowFilter === w && styles.windowChipTextActive]}>
              {w === '1' ? '1H' : w === '24' ? '24H' : 'ALL'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'audit' && (
        <View style={styles.searchRow}>
          <Search size={14} color={colors.textMuted} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search by phone or actor id"
            placeholderTextColor={colors.textMuted}
            onSubmitEditing={load}
            returnKeyType="search"
            style={styles.searchInput}
            autoCapitalize="none"
          />
          {actionFilter && (
            <TouchableOpacity onPress={() => setActionFilter(null)} style={styles.clearChip}>
              <Filter size={10} color={colors.warning} />
              <Text style={styles.clearChipText}>{actionFilter}</Text>
              <Text style={styles.clearChipX}>×</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {tab === 'audit' ? (
          <AuditList items={audit.items} loading={loading} onPickAction={setActionFilter} />
        ) : (
          <DeniedLogins data={denied} loading={loading} />
        )}
      </ScrollView>
    </View>
  );
}

function SegBtn({ label, active, onPress, count }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.segBtn, active && styles.segBtnActive]} activeOpacity={0.85}>
      <Text style={[styles.segText, active && styles.segTextActive]}>{label}</Text>
      {count != null && count > 0 && (
        <View style={styles.segBadge}><Text style={styles.segBadgeText}>{count > 99 ? '99+' : count}</Text></View>
      )}
    </TouchableOpacity>
  );
}

function AuditList({ items, loading, onPickAction }: any) {
  if (loading && !items?.length) {
    return <View style={styles.empty}><ActivityIndicator color={colors.red} /></View>;
  }
  if (!items?.length) {
    return <View style={styles.empty}><Text style={styles.emptyText}>No events in this window.</Text></View>;
  }
  return (
    <View>
      {items.map((ev: any) => {
        const meta = ACTION_META[ev.action] || { label: ev.action, tint: colors.textChrome, icon: ShieldAlert };
        const Icon = meta.icon;
        const phone = ev.meta?.phone || '';
        const actor = ev.actor_id ? `actor: ${ev.actor_id.slice(0, 8)}` : '';
        const ts = new Date(ev.ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        return (
          <View key={ev.id} style={styles.evRow}>
            <TouchableOpacity onPress={() => onPickAction(ev.action)} style={[styles.evIcon, { backgroundColor: meta.tint + '12', borderColor: meta.tint + '40' }]} activeOpacity={0.85}>
              <Icon size={14} color={meta.tint} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <View style={styles.evTopLine}>
                <Text style={[styles.evAction, { color: meta.tint }]}>{meta.label}</Text>
                <Text style={styles.evTs}>{ts}</Text>
              </View>
              {!!phone && <Text style={styles.evPhone}>{phone}</Text>}
              {!!ev.meta?.changes && (
                <Text style={styles.evMeta} numberOfLines={2}>{JSON.stringify(ev.meta.changes)}</Text>
              )}
              {!!ev.meta?.reason && <Text style={styles.evReasonText}>reason: {ev.meta.reason}</Text>}
              {!!actor && <Text style={styles.evActor}>{actor}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function DeniedLogins({ data, loading }: any) {
  if (loading && !data.items?.length) return <View style={styles.empty}><ActivityIndicator color={colors.red} /></View>;
  return (
    <View>
      {/* Repeat offender summary */}
      {data.repeat_offenders?.length > 0 && (
        <View style={styles.repeatCard}>
          <View style={styles.repeatHead}>
            <AlertOctagon size={14} color={colors.red} />
            <Text style={styles.repeatTitle}>REPEAT OFFENDERS</Text>
            <Text style={styles.repeatSub}>top {data.repeat_offenders.length}</Text>
          </View>
          {data.repeat_offenders.map((r: any) => (
            <View key={r.phone} style={styles.repeatRow}>
              <Text style={styles.repeatPhone}>{r.phone}</Text>
              <View style={styles.repeatPill}><Text style={styles.repeatPillText}>{r.attempts} attempts</Text></View>
            </View>
          ))}
        </View>
      )}

      <Text style={styles.feedHead}>RECENT DENIED ATTEMPTS · {data.items?.length || 0}</Text>
      {!data.items?.length ? (
        <View style={styles.empty}><Text style={styles.emptyText}>No denied attempts in this window.</Text></View>
      ) : data.items.map((ev: any) => {
        const isOperator = ev.action === 'operator_access_denied';
        const ts = new Date(ev.ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        return (
          <View key={ev.id} style={styles.deniedRow}>
            <View style={[styles.deniedIcon, isOperator && { borderColor: 'rgba(245,158,11,0.5)', backgroundColor: 'rgba(245,158,11,0.10)' }]}>
              {isOperator ? <AlertOctagon size={14} color={colors.warning} /> : <Ban size={14} color={colors.red} />}
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.evTopLine}>
                <Text style={[styles.deniedKind, { color: isOperator ? colors.warning : colors.red }]}>
                  {isOperator ? 'OPERATOR' : 'DEALER'}
                </Text>
                <Text style={styles.evTs}>{ts}</Text>
              </View>
              <Text style={styles.evPhone}>{ev.meta?.phone || '(no phone)'}</Text>
              {ev.meta?.reason && <Text style={styles.evReasonText}>reason: {ev.meta.reason}</Text>}
              {ev.meta?.stage && <Text style={styles.evReasonText}>stage: {ev.meta.stage}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 20, paddingBottom: 60 },

  segRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 8 },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard },
  segBtnActive: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: colors.red },
  segText: { color: colors.textChrome, fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },
  segTextActive: { color: colors.red },
  segBadge: { minWidth: 22, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: colors.red },
  segBadgeText: { color: '#fff', fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },

  windowRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, marginTop: 14 },
  windowLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2, marginRight: 4 },
  windowChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard },
  windowChipActive: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: colors.warning },
  windowChipText: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  windowChipTextActive: { color: colors.warning },

  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 20, marginTop: 12, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, flexWrap: 'wrap' },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: 12.5, fontWeight: '600', minWidth: 140 },
  clearChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)', backgroundColor: 'rgba(245,158,11,0.10)' },
  clearChipText: { color: colors.warning, fontSize: 9.5, fontWeight: '800' },
  clearChipX: { color: colors.warning, fontSize: 12, fontWeight: '900' },

  empty: { paddingVertical: 60, alignItems: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 12, fontWeight: '600', letterSpacing: 0.4 },

  evRow: { flexDirection: 'row', gap: 11, padding: 11, marginBottom: 7, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  evIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  evTopLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  evAction: { fontSize: 11.5, fontWeight: '900', letterSpacing: 0.3 },
  evTs: { color: colors.textMuted, fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'], letterSpacing: 0.3 },
  evPhone: { color: colors.textPrimary, fontSize: 12, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  evMeta: { color: colors.textChrome, fontSize: 10.5, marginTop: 2, fontFamily: Object.assign({}, { default: 'monospace' }).default || undefined },
  evReasonText: { color: colors.warning, fontSize: 10, marginTop: 2, fontWeight: '700', letterSpacing: 0.3 },
  evActor: { color: colors.textMuted, fontSize: 9.5, marginTop: 2, letterSpacing: 0.3 },

  repeatCard: { padding: 12, borderRadius: radii.md, backgroundColor: 'rgba(185,28,28,0.06)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.35)', marginBottom: 16 },
  repeatHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 9 },
  repeatTitle: { color: colors.red, fontSize: 10.5, fontWeight: '900', letterSpacing: 1.2 },
  repeatSub: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginLeft: 'auto' },
  repeatRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: 1, borderTopColor: 'rgba(185,28,28,0.18)' },
  repeatPhone: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  repeatPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.18)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.45)' },
  repeatPillText: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },

  feedHead: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2, marginBottom: 8, marginTop: 4 },
  deniedRow: { flexDirection: 'row', gap: 11, padding: 11, marginBottom: 7, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: 'rgba(185,28,28,0.25)' },
  deniedIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  deniedKind: { fontSize: 10.5, fontWeight: '900', letterSpacing: 1 },
});
