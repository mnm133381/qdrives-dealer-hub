/**
 * Operator Live Ops Dashboard.
 *
 * Trading-terminal dense layout, three sections:
 *   1. Live Auctions Grid — every monitorable auction with one-tap pause/
 *      extend/force-close. Updates poll every 5s + WS-driven hooks (Phase 3).
 *   2. Settlement Pipeline strip — counts per state.
 *   3. Risk Strip — 6 categories of dealer risk surfaced inline.
 *
 * Built for operator-grade speed: monospace numerics, no oversized cards,
 * primary actions live in one tap.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Gavel, Clock, Pause, Play, FastForward, ShieldX, Flame, Users,
  AlertOctagon, ChevronRight, Banknote, ArrowRight, BadgeAlert,
  Activity, TrendingUp, Inbox, CheckCircle2, Truck, FileWarning, UserPlus,
} from 'lucide-react-native';
import { colors, radii, formatINR } from '../../src/theme';
import { api } from '../../src/api';
import { AdminHeader } from '../../src/components/AdminHeader';
import { ReasonModal } from '../../src/components/ReasonModal';
import { useToast } from '../../src/toast';

export default function AdminOpsDashboard() {
  const router = useRouter();
  const toast = useToast();
  const [grid, setGrid] = useState<any[]>([]);
  const [risk, setRisk] = useState<any | null>(null);
  const [pendingDealers, setPendingDealers] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Reason modal state for pause / force-close / cancel
  const [reasonModal, setReasonModal] = useState<{
    visible: boolean; auctionId: string; action: 'pause' | 'force_close' | 'cancel'; title: string; cta: string;
  } | null>(null);
  const [reasonBusy, setReasonBusy] = useState(false);

  // Track whether a load is currently in flight so 6s polling and pull-to-
  // refresh don't double-fire and create flicker.
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return; // debounce: skip if a load is already in flight
    loadingRef.current = true;
    setLoading(true);
    try {
      const [g, r] = await Promise.all([api.adminLiveGrid(), api.adminRiskDealers()]);
      setGrid(g.items || []);
      setPendingDealers(g.pending_dealers || 0);
      setRisk(r);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load ops', 'error');
    } finally { setLoading(false); loadingRef.current = false; }
  }, []);

  useFocusEffect(useCallback(() => {
    load();
    const t = setInterval(load, 6000); // poll every 6s
    return () => clearInterval(t);
  }, [load]));

  // Local timer tick for time_left countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const counts = {
    live: grid.filter((a) => a.status === 'live').length,
    paused: grid.filter((a) => a.status === 'paused').length,
    pending: grid.filter((a) => a.status === 'ended_pending_payment').length,
    payment: grid.filter((a) => a.status === 'payment_received').length,
    released: grid.filter((a) => a.status === 'vehicle_released').length,
    dispute: grid.filter((a) => a.status === 'dispute').length,
  };

  // GMV today (sum of current_bid for non-terminal auctions)
  const gmv = grid.reduce((s, a) => s + (a.current_bid || 0), 0);
  const liveBids = grid.filter((a) => a.status === 'live').reduce((s, a) => s + (a.total_bids || 0), 0);

  const onResume = async (id: string) => {
    try { await api.adminResumeAuction(id); toast.show('Resumed', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };
  const onExtend = async (id: string) => {
    try { await api.adminExtendAuction(id, 60, 'Quick +60s'); toast.show('Extended +60s', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };

  const submitReason = async (reason: string) => {
    if (!reasonModal) return;
    setReasonBusy(true);
    try {
      const fn = reasonModal.action === 'pause'
        ? api.adminPauseAuction
        : reasonModal.action === 'force_close'
          ? api.adminForceClose
          : api.adminCancelAuction;
      await fn(reasonModal.auctionId, reason);
      toast.show(reasonModal.action === 'pause' ? 'Paused' : reasonModal.action === 'force_close' ? 'Force-closed' : 'Cancelled', 'success');
      setReasonModal(null);
      load();
    } catch (e: any) {
      toast.show(e.message || 'Failed', 'error');
    } finally { setReasonBusy(false); }
  };

  return (
    <View style={styles.root}>
      <AdminHeader
        kicker="Operations"
        title="Live ops"
        sub="Real-time auction monitor · pipeline · risk"
      />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* HEADLINE KPIs */}
        <View style={styles.kpiRow}>
          <Kpi icon={<Flame size={14} color={colors.red} />} label="LIVE" value={`${counts.live}`} tint={colors.red} />
          <Kpi icon={<Inbox size={14} color={colors.warning} />} label="PENDING $$" value={`${counts.pending}`} tint={colors.warning} />
          <Kpi icon={<Truck size={14} color={colors.silver} />} label="RELEASED" value={`${counts.released}`} />
          <Kpi icon={<FileWarning size={14} color={colors.red} />} label="DISPUTE" value={`${counts.dispute}`} tint={colors.red} />
        </View>
        <View style={styles.gmvBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.gmvLabel}>OPEN GMV</Text>
            <Text style={styles.gmvVal}>{formatINR(gmv)}</Text>
          </View>
          <View style={styles.divv} />
          <View style={{ flex: 1 }}>
            <Text style={styles.gmvLabel}>BIDS PLACED</Text>
            <Text style={styles.gmvVal}>{liveBids}</Text>
          </View>
        </View>

        {/* PENDING APPROVALS — operator approval queue badge */}
        {pendingDealers > 0 && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push('/(admin)/dealers?status=pending' as any)}
            style={styles.pendingTile}
            testID="kpi-pending-approvals"
          >
            <View style={styles.pendingIcon}>
              <UserPlus size={16} color={colors.warning} strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.pendingKicker}>PENDING APPROVALS · NEW</Text>
              <Text style={styles.pendingTitle}>
                {pendingDealers} dealer{pendingDealers === 1 ? '' : 's'} awaiting review
              </Text>
            </View>
            <View style={styles.pendingCount}>
              <Text style={styles.pendingCountText}>{pendingDealers}</Text>
            </View>
            <ChevronRight size={16} color={colors.warning} />
          </TouchableOpacity>
        )}

        {/* LIVE AUCTIONS GRID */}
        <View style={styles.sectionHead}>
          <Gavel size={13} color={colors.textChrome} />
          <Text style={styles.sectionTitle}>LIVE AUCTIONS</Text>
          <Text style={styles.sectionCount}>{grid.length}</Text>
        </View>
        {loading && grid.length === 0 ? (
          <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>
        ) : grid.length === 0 ? (
          <View style={styles.emptyCard} testID="live-grid-empty">
            <View style={styles.emptyIcon}><Inbox size={20} color={colors.textChrome} /></View>
            <Text style={styles.emptyTitle}>No live auctions</Text>
            <Text style={styles.emptyBody}>Pipeline is idle. Launch a new auction from the Inventory tab or pull-to-refresh to re-poll.</Text>
            <TouchableOpacity onPress={() => router.push('/(admin)/launch' as any)} style={styles.emptyCta} testID="live-grid-empty-cta">
              <Text style={styles.emptyCtaText}>+ LAUNCH AUCTION</Text>
            </TouchableOpacity>
          </View>
        ) : (
          grid.map((a) => (
            <AuctionRow
              key={a.id} a={a} now={now}
              onTap={() => router.push(`/(admin)/auction/${a.id}` as any)}
              onPause={() => setReasonModal({ visible: true, auctionId: a.id, action: 'pause', title: 'Pause this auction', cta: 'Pause' })}
              onResume={() => onResume(a.id)}
              onExtend={() => onExtend(a.id)}
              onForceClose={() => setReasonModal({ visible: true, auctionId: a.id, action: 'force_close', title: 'Force-close this auction', cta: 'Force-close' })}
              onCancel={() => setReasonModal({ visible: true, auctionId: a.id, action: 'cancel', title: 'Cancel this auction', cta: 'Cancel' })}
            />
          ))
        )}

        {/* SETTLEMENT PIPELINE */}
        <View style={[styles.sectionHead, { marginTop: 24 }]}>
          <Activity size={13} color={colors.textChrome} />
          <Text style={styles.sectionTitle}>SETTLEMENT PIPELINE</Text>
          <TouchableOpacity onPress={() => router.push('/(admin)/settlement' as any)} style={styles.linkBtn} testID="open-settlement-pipeline">
            <Text style={styles.linkBtnText}>OPEN ›</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity activeOpacity={0.85} onPress={() => router.push('/(admin)/settlement' as any)}>
          <View style={styles.pipeline}>
            <PipeStage label="PENDING $" count={counts.pending} icon={<Inbox size={12} color={colors.warning} />} tint={colors.warning} />
            <PipeArrow />
            <PipeStage label="PAID" count={counts.payment} icon={<CheckCircle2 size={12} color={colors.silver} />} />
            <PipeArrow />
            <PipeStage label="RELEASED" count={counts.released} icon={<Truck size={12} color={colors.success} />} tint={colors.success} />
            <PipeArrow />
            <PipeStage label="DISPUTE" count={counts.dispute} icon={<FileWarning size={12} color={colors.red} />} tint={counts.dispute > 0 ? colors.red : undefined} />
          </View>
        </TouchableOpacity>

        {/* RISK STRIP */}
        <View style={[styles.sectionHead, { marginTop: 24 }]}>
          <ShieldX size={13} color={colors.textChrome} />
          <Text style={styles.sectionTitle}>DEALER RISK</Text>
        </View>
        {!risk ? (
          <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>
        ) : (
          <View style={styles.riskGrid}>
            <RiskTile icon={<ShieldX size={14} color={colors.red} />} label="Suspended" count={risk.suspended?.length || 0} tint={colors.red} testID="risk-suspended" />
            <RiskTile icon={<BadgeAlert size={14} color={colors.warning} />} label="Repeat denied (24h)" count={risk.repeat_denied_24h?.length || 0} tint={colors.warning} testID="risk-denied" />
            <RiskTile icon={<AlertOctagon size={14} color={colors.warning} />} label="Cancellations (7d)" count={risk.cancellations_7d?.length || 0} testID="risk-cancellations" />
            <RiskTile icon={<TrendingUp size={14} color={colors.warning} />} label="Abnormal freq (1h)" count={risk.abnormal_frequency_1h?.length || 0} testID="risk-frequency" />
            <RiskTile icon={<Banknote size={14} color={colors.warning} />} label="High-value spike (24h)" count={risk.high_value_spikes_24h?.length || 0} testID="risk-spikes" />
            <RiskTile icon={<Users size={14} color={colors.silver} />} label="Inactive high-limit" count={risk.inactive_high_limit?.length || 0} testID="risk-inactive" />
          </View>
        )}
      </ScrollView>

      {reasonModal && (
        <ReasonModal
          visible={reasonModal.visible}
          title={reasonModal.title}
          cta={reasonModal.cta}
          danger={reasonModal.action !== 'pause'}
          busy={reasonBusy}
          onClose={() => setReasonModal(null)}
          onSubmit={submitReason}
        />
      )}
    </View>
  );
}

function Kpi({ icon, label, value, tint }: any) {
  return (
    <View style={[styles.kpi, tint && { borderColor: tint + '40' }]}>
      <View style={styles.kpiHead}>{icon}<Text style={[styles.kpiLabel, tint && { color: tint }]}>{label}</Text></View>
      <Text style={styles.kpiVal}>{value}</Text>
    </View>
  );
}

function AuctionRow({ a, now, onTap, onPause, onResume, onExtend, onForceClose, onCancel }: any) {
  // recompute time_left dynamically (avoids polling for second-level updates)
  const endMs = a.end_time ? new Date(a.end_time).getTime() : 0;
  const timeLeft = Math.max(0, Math.floor((endMs - now) / 1000));
  const m = Math.floor(timeLeft / 60), s = timeLeft % 60;
  const tStr = timeLeft > 0 ? `${m}:${s.toString().padStart(2, '0')}` : '0:00';
  const ending = timeLeft > 0 && timeLeft <= 60;
  const isLive = a.status === 'live';
  const isPaused = a.status === 'paused';
  const isPending = a.status === 'ended_pending_payment';
  const statusTint = isLive ? colors.success : isPaused ? colors.warning : isPending ? colors.warning : colors.textMuted;
  const statusLabel = (a.status || 'unknown').toUpperCase().replace(/_/g, ' ');

  return (
    <TouchableOpacity onPress={onTap} activeOpacity={0.85} style={styles.row} testID={`live-row-${a.id}`}>
      <View style={styles.rowHead}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {a.car?.year || ''} {a.car?.make || ''} {a.car?.model || ''}
        </Text>
        <View style={[styles.statusPill, { backgroundColor: statusTint + '14', borderColor: statusTint + '55' }]}>
          <View style={[styles.statusDot, { backgroundColor: statusTint }]} />
          <Text style={[styles.statusText, { color: statusTint }]}>{statusLabel}</Text>
        </View>
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.regNo}>{a.car?.registration_number || '—'}</Text>
        <Text style={styles.metaSep}>·</Text>
        <Text style={styles.metaItem}>{a.total_bids || 0} bids</Text>
        {a.velocity_60s > 0 && (
          <>
            <Text style={styles.metaSep}>·</Text>
            <Text style={[styles.metaItem, { color: colors.warning, fontWeight: '900' }]}>
              {a.velocity_60s}/min ↑
            </Text>
          </>
        )}
        <Text style={styles.metaSep}>·</Text>
        <Text style={styles.metaItem}>{a.watcher_count || 0} watching</Text>
      </View>
      <View style={styles.rowMid}>
        <View style={{ flex: 1 }}>
          <Text style={styles.priceLabel}>HIGHEST</Text>
          <Text style={styles.price}>{formatINR(a.current_bid || 0)}</Text>
          {a.reserve_price ? (
            <Text style={[styles.reserve, { color: a.reserve_met ? colors.success : colors.textMuted }]}>
              Reserve {a.reserve_met ? 'met' : `₹${(a.reserve_price/100000).toFixed(1)}L`}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.priceLabel}>{ending ? 'ENDING' : 'TIME LEFT'}</Text>
          <Text style={[styles.timer, ending && { color: colors.red }]}>{tStr}</Text>
          {a.extension_count > 0 && (
            <Text style={styles.extCount}>+{a.extension_count} ext</Text>
          )}
        </View>
      </View>
      {a.top_bidder ? (
        <View style={styles.bidder}>
          <Text style={styles.bidderLabel}>TOP BIDDER</Text>
          <Text style={styles.bidderName} numberOfLines={1}>{a.top_bidder.dealership_name || 'Dealer'}</Text>
          <Text style={styles.bidderTrust}>{a.top_bidder.trust_score?.toFixed(1) || '4.5'}★</Text>
          {a.top_bidder.max_bid_limit && (
            <Text style={styles.bidderCap}>cap {formatINR(a.top_bidder.max_bid_limit)}</Text>
          )}
        </View>
      ) : null}
      <View style={styles.actions}>
        {isLive && (
          <>
            <ActionBtn icon={<Pause size={11} color={colors.warning} />} label="Pause" tint={colors.warning} onPress={onPause} testID={`live-pause-${a.id}`} />
            <ActionBtn icon={<FastForward size={11} color={colors.silver} />} label="+60s" onPress={onExtend} testID={`live-extend-${a.id}`} />
            <ActionBtn icon={<Flame size={11} color={colors.red} />} label="Force" tint={colors.red} onPress={onForceClose} testID={`live-fc-${a.id}`} />
          </>
        )}
        {isPaused && (
          <>
            <ActionBtn icon={<Play size={11} color={colors.success} />} label="Resume" tint={colors.success} onPress={onResume} testID={`live-resume-${a.id}`} />
            <ActionBtn icon={<Flame size={11} color={colors.red} />} label="Force" tint={colors.red} onPress={onForceClose} testID={`live-fc-${a.id}`} />
          </>
        )}
        {(isLive || isPaused) && (
          <ActionBtn icon={<ShieldX size={11} color={colors.red} />} label="Cancel" tint={colors.red} onPress={onCancel} testID={`live-cancel-${a.id}`} />
        )}
        <View style={{ flex: 1 }} />
        <ChevronRight size={14} color={colors.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

function ActionBtn({ icon, label, onPress, tint, testID }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.actionBtn, tint && { borderColor: tint + '55', backgroundColor: tint + '12' }]} activeOpacity={0.85} testID={testID}>
      {icon}
      <Text style={[styles.actionText, tint && { color: tint }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PipeStage({ label, count, icon, tint }: any) {
  return (
    <View style={[styles.pipeStage, tint && { borderColor: tint + '55', backgroundColor: tint + '10' }]}>
      {icon}
      <Text style={styles.pipeLabel}>{label}</Text>
      <Text style={[styles.pipeCount, tint && { color: tint }]}>{count}</Text>
    </View>
  );
}
function PipeArrow() {
  return <View style={styles.pipeArrowBox}><ArrowRight size={11} color={colors.textMuted} /></View>;
}

function RiskTile({ icon, label, count, tint, testID }: any) {
  const isHot = (count || 0) > 0;
  return (
    <View style={[styles.riskTile, isHot && tint && { borderColor: tint + '55', backgroundColor: tint + '10' }]} testID={testID}>
      <View style={styles.riskHead}>{icon}<Text style={styles.riskCount}>{count || 0}</Text></View>
      <Text style={styles.riskLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 18, paddingTop: 8, paddingBottom: 80 },

  kpiRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  kpi: { flex: 1, padding: 11, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kpiHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  kpiLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  kpiVal: { color: colors.textPrimary, fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },

  gmvBar: { flexDirection: 'row', padding: 12, borderRadius: radii.md, backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: 'rgba(185,28,28,0.30)', marginBottom: 18 },
  gmvLabel: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  gmvVal: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'], letterSpacing: -0.3 },
  divv: { width: 1, height: 32, backgroundColor: colors.border, marginHorizontal: 14, alignSelf: 'center' },

  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  sectionTitle: { color: colors.textChrome, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  sectionCount: { color: colors.red, fontSize: 11, fontWeight: '900', marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  linkBtn: { marginLeft: 'auto', paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(185,28,28,0.45)', backgroundColor: 'rgba(185,28,28,0.06)' },
  linkBtnText: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1 },

  pendingTile: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderRadius: radii.lg, backgroundColor: 'rgba(245,158,11,0.06)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.45)', marginBottom: 14 },
  pendingIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,158,11,0.10)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.40)' },
  pendingKicker: { color: colors.warning, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  pendingTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '800', marginTop: 3 },
  pendingCount: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.warning, marginRight: 4 },
  pendingCountText: { color: '#0c0c0c', fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },

  loader: { paddingVertical: 30, alignItems: 'center' },
  empty: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center', paddingVertical: 30 },
  emptyCard: { padding: 22, alignItems: 'center', borderRadius: radii.lg, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', marginBottom: 14 },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
  emptyTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', letterSpacing: 0.4 },
  emptyBody: { color: colors.textChrome, fontSize: 11.5, fontWeight: '600', textAlign: 'center', marginTop: 4, marginBottom: 12, lineHeight: 16 },
  emptyCta: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.10)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.45)' },
  emptyCtaText: { color: colors.red, fontSize: 11, fontWeight: '900', letterSpacing: 1 },

  row: { padding: 13, borderRadius: radii.lg, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, marginBottom: 10 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowTitle: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 8.5, fontWeight: '900', letterSpacing: 0.7 },

  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5, flexWrap: 'wrap' },
  regNo: { color: colors.textChrome, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'], letterSpacing: 0.4 },
  metaSep: { color: colors.textMuted, fontSize: 11 },
  metaItem: { color: colors.textChrome, fontSize: 11, fontWeight: '600' },

  rowMid: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, marginTop: 11, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.border },
  priceLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  price: { color: colors.textPrimary, fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.4, marginTop: 2 },
  reserve: { fontSize: 10.5, fontWeight: '700', marginTop: 2, letterSpacing: 0.4 },
  timer: { color: colors.textPrimary, fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.4, marginTop: 2 },
  extCount: { color: colors.warning, fontSize: 10.5, fontWeight: '700', marginTop: 2, letterSpacing: 0.4 },

  bidder: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.border },
  bidderLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  bidderName: { flex: 1, color: colors.textPrimary, fontSize: 12, fontWeight: '800' },
  bidderTrust: { color: colors.warning, fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  bidderCap: { color: colors.textChrome, fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },

  actions: { flexDirection: 'row', gap: 6, marginTop: 11, alignItems: 'center' },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  actionText: { color: colors.textChrome, fontSize: 10.5, fontWeight: '900', letterSpacing: 0.4 },

  pipeline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pipeStage: { flex: 1, padding: 9, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  pipeLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.6, marginTop: 4 },
  pipeCount: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'] },
  pipeArrowBox: { width: 14, alignItems: 'center' },

  riskGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  riskTile: { width: '48%', padding: 11, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  riskHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  riskCount: { color: colors.textPrimary, fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums'] },
  riskLabel: { color: colors.textChrome, fontSize: 10.5, fontWeight: '700', marginTop: 4, letterSpacing: 0.3 },
});
