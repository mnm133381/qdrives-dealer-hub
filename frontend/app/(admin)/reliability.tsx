/**
 * Operator Reliability Console — tightly scoped to auction integrity
 * and platform reliability. NOT a BI dashboard. NOT vanity analytics.
 *
 * Sections (top → bottom, by operational urgency):
 *   1. Intervention Alerts — derived flags requiring human attention
 *   2. WebSocket Health — live gauge + churn rate + reconnect storms
 *   3. Bid Propagation — broadcast lag p50/p95/max + race conflicts
 *   4. Active Auctions — live, ending soon, paused, close races
 *   5. Failed Bids — last-hour event counts (race conflicts, dups)
 *
 * Auto-refresh: every 10s. No charts. No drill-downs deeper than
 * "tap an auction → its admin page".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Activity, AlertOctagon, AlertTriangle, Info, Wifi, Radio,
  Gavel, ChevronRight, Hourglass, RefreshCw, Zap, ShieldAlert,
} from 'lucide-react-native';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';

const REFRESH_MS = 10_000;

type Health = Awaited<ReturnType<typeof api.adminRealtimeHealth>>;

export default function OperatorReliability() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<any>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.adminRealtimeHealth();
      if (!mountedRef.current) return;
      setData(r);
      setErr(null);
      setLastUpdated(new Date());
    } catch (e: any) {
      if (!mountedRef.current) return;
      setErr(String(e?.message || 'Failed to load'));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load(false);
    timerRef.current = setInterval(() => load(true), REFRESH_MS);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const auctions = data?.auctions || { live: 0, ending_in_5m: 0, paused: 0 };
  const lag = data?.broadcast_lag_ms;
  const events1h = data?.events_1h || {};
  const wsConn = events1h['ws_connect'] || 0;
  const wsDisc = events1h['ws_disconnect'] || 0;
  const churnRate = wsConn > 0 ? Math.min(100, Math.round((wsDisc / Math.max(1, wsConn)) * 100)) : 0;
  const dups = events1h['bid_duplicate_attempt'] || 0;
  const races = events1h['bid_race_conflict'] || 0;
  const closeRaces = events1h['auction_close_race'] || 0;
  const oOO = events1h['frame_out_of_order'] || 0;
  const recon = events1h['ws_reconnect'] || 0;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="rel-back">
          <ArrowLeft size={18} color={colors.textChrome} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>OPS · RELIABILITY</Text>
          <Text style={styles.title}>Reliability Console</Text>
        </View>
        <TouchableOpacity onPress={onRefresh} style={styles.refreshBtn} testID="rel-refresh">
          <RefreshCw size={14} color={colors.textChrome} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom, 24) + 60 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.silver} />}
      >
        {loading && !data ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.silver} />
            <Text style={styles.loadingText}>Loading reliability snapshot…</Text>
          </View>
        ) : err && !data ? (
          <View style={styles.errBox}>
            <AlertOctagon size={16} color={colors.red} />
            <Text style={styles.errText}>{err}</Text>
          </View>
        ) : data ? (
          <>
            {/* ─── SECTION 1: Intervention Alerts ─── */}
            {(data.alerts || []).length > 0 ? (
              <View style={styles.section}>
                <SectionHead icon={<AlertOctagon size={12} color={colors.red} />} title="INTERVENTION ALERTS" />
                {data.alerts.map((al) => (
                  <AlertRow key={al.id} alert={al} onPress={() => al.route && router.push(al.route as any)} />
                ))}
              </View>
            ) : (
              <View style={styles.allClear} testID="rel-all-clear">
                <Activity size={14} color={colors.success} />
                <Text style={styles.allClearText}>No active interventions. Auctions running cleanly.</Text>
              </View>
            )}

            {/* ─── SECTION 2: WebSocket Health ─── */}
            <View style={styles.section}>
              <SectionHead icon={<Wifi size={12} color={colors.silver} />} title="WEBSOCKET HEALTH" />
              <View style={styles.gridRow}>
                <Stat label="Live connections" value={String(data.live_ws)} hint={`${(data.rooms || []).length} rooms`} />
                <Stat label="Churn 1h" value={`${churnRate}%`} hint={`${wsConn} conn / ${wsDisc} disc`} tone={churnRate > 60 ? 'warn' : undefined} />
              </View>
              <View style={styles.gridRow}>
                <Stat label="Reconnects 1h" value={String(recon)} hint="WS resumes" />
                <Stat
                  label="Active storms"
                  value={String((data.active_storms || []).length)}
                  hint="dealers >5 reconnects/5m"
                  tone={(data.active_storms || []).length > 0 ? 'critical' : undefined}
                />
              </View>
              {(data.active_storms || []).length > 0 && (
                <View style={styles.subList}>
                  {data.active_storms.slice(0, 5).map((s, i) => (
                    <TouchableOpacity
                      key={`${s.dealer_id}-${i}`}
                      style={styles.subRow}
                      onPress={() => s.dealer_id && router.push(`/(admin)/dealer/${s.dealer_id}` as any)}
                      testID={`storm-row-${i}`}
                    >
                      <ShieldAlert size={11} color={colors.warning} />
                      <Text style={styles.subRowText} numberOfLines={1}>
                        Dealer <Text style={styles.subRowEm}>{(s.dealer_id || '').slice(0, 8)}</Text> — {s.reconnects_5min} reconnects in 5m
                      </Text>
                      <ChevronRight size={11} color={colors.textMuted} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* ─── SECTION 3: Bid Propagation ─── */}
            <View style={styles.section}>
              <SectionHead icon={<Radio size={12} color={colors.silver} />} title="BID PROPAGATION" />
              <View style={styles.gridRow}>
                <Stat
                  label="Broadcast p50"
                  value={lag?.p50 != null ? `${lag.p50}ms` : '—'}
                  hint={lag?.samples ? `${lag.samples} spikes` : 'no spikes'}
                />
                <Stat
                  label="Broadcast p95"
                  value={lag?.p95 != null ? `${lag.p95}ms` : '—'}
                  hint={lag?.max != null ? `peak ${lag.max}ms` : '—'}
                  tone={lag?.p95 != null && lag.p95 > 1000 ? 'warn' : undefined}
                />
              </View>
              <View style={styles.gridRow}>
                <Stat label="Race conflicts 1h" value={String(races)} hint="losers on CAS" tone={races > 10 ? 'warn' : undefined} />
                <Stat label="Out-of-order 1h" value={String(oOO)} hint="client-reported" tone={oOO > 20 ? 'warn' : undefined} />
              </View>
              {(data.race_top_auctions || []).length > 0 && (
                <View style={styles.subList}>
                  <Text style={styles.subListLabel}>TOP RACE-CONTESTED AUCTIONS</Text>
                  {data.race_top_auctions.map((r, i) => (
                    <TouchableOpacity
                      key={`${r.auction_id}-${i}`}
                      style={styles.subRow}
                      onPress={() => r.auction_id && router.push(`/(admin)/auction/${r.auction_id}` as any)}
                      testID={`race-row-${i}`}
                    >
                      <Gavel size={11} color={colors.warning} />
                      <Text style={styles.subRowText} numberOfLines={1}>
                        Auction <Text style={styles.subRowEm}>{(r.auction_id || '').slice(0, 8)}</Text> — {r.conflicts_1h} conflicts
                      </Text>
                      <ChevronRight size={11} color={colors.textMuted} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* ─── SECTION 4: Active Auction Health ─── */}
            <View style={styles.section}>
              <SectionHead icon={<Hourglass size={12} color={colors.silver} />} title="ACTIVE AUCTIONS" />
              <View style={styles.gridRow}>
                <Stat label="Live" value={String(auctions.live)} hint="status=live" />
                <Stat
                  label="Ending in 5m"
                  value={String(auctions.ending_in_5m)}
                  hint="watch close-race"
                  tone={auctions.ending_in_5m > 3 ? 'warn' : undefined}
                />
              </View>
              <View style={styles.gridRow}>
                <Stat label="Paused" value={String(auctions.paused)} hint="operator action" tone={auctions.paused > 0 ? 'warn' : undefined} />
                <Stat label="Close races 1h" value={String(closeRaces)} hint="bids in final 2s" />
              </View>
              {(data.close_races_1h || []).length > 0 && (
                <View style={styles.subList}>
                  <Text style={styles.subListLabel}>RECENT CLOSE-RACES</Text>
                  {data.close_races_1h.slice(0, 5).map((c, i) => (
                    <TouchableOpacity
                      key={`${c.auction_id}-${i}`}
                      style={styles.subRow}
                      onPress={() => c.auction_id && router.push(`/(admin)/auction/${c.auction_id}` as any)}
                      testID={`closerace-row-${i}`}
                    >
                      <Zap size={11} color={colors.red} />
                      <Text style={styles.subRowText} numberOfLines={1}>
                        Auction <Text style={styles.subRowEm}>{(c.auction_id || '').slice(0, 8)}</Text> — bid +{c.skew_ms}ms before close
                      </Text>
                      <ChevronRight size={11} color={colors.textMuted} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* ─── SECTION 5: Failed / Rejected Bids ─── */}
            <View style={styles.section}>
              <SectionHead icon={<AlertTriangle size={12} color={colors.silver} />} title="FAILED / REJECTED BIDS (1h)" />
              <View style={styles.gridRow}>
                <Stat label="Race losers" value={String(races)} hint="409 BID_OUTBID" />
                <Stat
                  label="Duplicate attempts"
                  value={String(dups)}
                  hint="idempotency hits"
                  tone={dups > 50 ? 'warn' : undefined}
                />
              </View>
              <Text style={styles.thresholds}>
                Thresholds — race spike alert: {data.thresholds?.race_spike_alert_1h ?? 10}/h ·
                broadcast lag: {data.thresholds?.broadcast_lag_spike_ms ?? 500}ms ·
                close-race window: {data.thresholds?.auction_close_race_window_ms ?? 2000}ms
              </Text>
            </View>

            {/* Footer — last updated */}
            <View style={styles.footer}>
              <Info size={10} color={colors.textMuted} />
              <Text style={styles.footerText}>
                Auto-refresh every {REFRESH_MS / 1000}s · last updated {lastUpdated ? lastUpdated.toLocaleTimeString() : '—'}
              </Text>
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function SectionHead({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <View style={styles.sectionHead}>
      {icon}
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'warn' | 'critical' }) {
  const valueColor =
    tone === 'critical' ? colors.red :
    tone === 'warn' ? colors.warning :
    colors.text;
  return (
    <View style={styles.statCell}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color: valueColor }]}>{value}</Text>
      {!!hint && <Text style={styles.statHint}>{hint}</Text>}
    </View>
  );
}

function AlertRow({ alert, onPress }: { alert: any; onPress: () => void }) {
  const icon =
    alert.severity === 'critical' ? <AlertOctagon size={14} color={colors.red} /> :
    alert.severity === 'warn' ? <AlertTriangle size={14} color={colors.warning} /> :
    <Info size={14} color={colors.silver} />;
  const borderColor =
    alert.severity === 'critical' ? colors.red + '60' :
    alert.severity === 'warn' ? colors.warning + '60' :
    colors.border;
  return (
    <TouchableOpacity
      style={[styles.alertCard, { borderColor }]}
      onPress={onPress}
      activeOpacity={alert.route ? 0.85 : 1}
      disabled={!alert.route}
      testID={`alert-${alert.id}`}
    >
      <View style={styles.alertIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.alertTitle}>{alert.title}</Text>
        <Text style={styles.alertDetail}>{alert.detail}</Text>
      </View>
      {alert.route && <ChevronRight size={14} color={colors.textMuted} />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border,
  },
  refreshBtn: {
    width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border,
  },
  kicker: { color: colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  title: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 2 },
  scroll: { padding: 16, gap: 16 },

  loadingWrap: { padding: 32, alignItems: 'center', gap: 10 },
  loadingText: { color: colors.textMuted, fontSize: 12 },

  errBox: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.red + '60',
    backgroundColor: colors.red + '10',
  },
  errText: { color: colors.red, fontSize: 12, flex: 1 },

  allClear: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14,
    borderRadius: radii.md, borderWidth: 1, borderColor: colors.success + '40',
    backgroundColor: colors.success + '10',
  },
  allClearText: { color: colors.success, fontSize: 12, fontWeight: '600', flex: 1 },

  section: {
    backgroundColor: colors.bgCard, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border, padding: 14, gap: 10,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle: { color: colors.textChrome, fontSize: 10, fontWeight: '700', letterSpacing: 1 },

  gridRow: { flexDirection: 'row', gap: 10 },
  statCell: {
    flex: 1, padding: 12, borderRadius: radii.md,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  statLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: 22, fontWeight: '700', marginTop: 4 },
  statHint: { color: colors.textMuted, fontSize: 10, marginTop: 2 },

  subList: { marginTop: 4, gap: 6 },
  subListLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 2 },
  subRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10,
    borderRadius: radii.sm, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  subRowText: { color: colors.text, fontSize: 11, flex: 1 },
  subRowEm: { color: colors.silver, fontWeight: '700' },

  alertCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12,
    borderRadius: radii.md, borderWidth: 1, backgroundColor: colors.bgCard,
  },
  alertIcon: { width: 22, alignItems: 'center', paddingTop: 1 },
  alertTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
  alertDetail: { color: colors.textMuted, fontSize: 11, marginTop: 2, lineHeight: 15 },

  thresholds: { color: colors.textMuted, fontSize: 10, lineHeight: 14, marginTop: 4 },

  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, justifyContent: 'center' },
  footerText: { color: colors.textMuted, fontSize: 10 },
});
