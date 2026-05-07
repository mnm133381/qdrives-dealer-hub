/**
 * Operator Live Ops Dashboard — high-speed command console.
 *
 * Trading-terminal layout optimised for the "understand platform state in
 * <3 seconds" mandate. Sections, in cognition-priority order:
 *
 *   1. ATTENTION RAIL — single intervention strip surfaces disputes,
 *      paused auctions, pending payments, ending-soon, and approval
 *      queue in one tappable line. Hidden when nothing requires action.
 *   2. COMMAND BAR — replaces the legacy 4-KPI block + GMV strip with
 *      one dense row of 7 mono-numeric cells (LIVE / PAUSED / PEND $ /
 *      DSPT / REL'D / OPEN GMV / BIDS).
 *   3. LIVE AUCTIONS — sorted by urgency (dispute → ending<60s →
 *      ending<5m → paused → pend$ → high-velocity live → others). Each
 *      row carries a 3px left edge tint encoding urgency pre-attentively.
 *   4. SETTLEMENT PIPELINE — tighter PEND $ → PAID → REL'D → DSPT.
 *   5. DEALER ANOMALY FEED — replaces the 6 decorative risk tiles with
 *      an actionable list: only renders categories with active signals
 *      and offers a tap-to-triage on every row.
 *
 * Style mandate: monospace numerics, sub-9pt kickers, no oversized
 * decoration, edge tints over status pills, clean state confirmation
 * over zero-tile chrome.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Animated, Easing,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Gavel, Pause, Play, FastForward, ShieldX, Flame, Users,
  AlertOctagon, ChevronRight, Banknote, ArrowRight, BadgeAlert,
  Activity, TrendingUp, Inbox, CheckCircle2, Truck, FileWarning, UserPlus,
  Zap, Siren,
} from 'lucide-react-native';
import { colors, formatINR } from '../../src/theme';
import { formatCountdown, statusBadge } from '../../src/lifecycle';
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

  // Operator-cognition urgency rank — sort the grid so operators see what
  // demands intervention FIRST. Ranks are stable: dispute → ending<60s →
  // ending<5m → paused → pending payment → high-velocity live → other.
  const rank = (a: any) => {
    const endMs = a.end_time ? new Date(a.end_time).getTime() : 0;
    const left = endMs ? Math.max(0, Math.floor((endMs - now) / 1000)) : 99999;
    if (a.status === 'dispute') return 0;
    if (a.status === 'live' && left > 0 && left <= 60) return 1;
    if (a.status === 'live' && left > 0 && left <= 300) return 2;
    if (a.status === 'paused') return 3;
    if (a.status === 'ended_pending_payment') return 4;
    if (a.status === 'live' && (a.velocity_60s || 0) >= 3) return 5;
    if (a.status === 'live') return 6;
    if (a.status === 'payment_received') return 7;
    if (a.status === 'vehicle_released') return 8;
    return 9;
  };
  const sortedGrid = useMemo(
    () => [...grid].sort((a, b) => rank(a) - rank(b) || (a.end_time ? new Date(a.end_time).getTime() : 0) - (b.end_time ? new Date(b.end_time).getTime() : 0)),
    [grid, now]
  );

  // Risk anomalies — dense actionable feed. Only shows categories with
  // active signals so operators don't waste cognition on zero-rows.
  const anomalies = useMemo(() => {
    if (!risk) return [] as any[];
    const out: any[] = [];
    if ((risk.suspended || []).length) out.push({ key: 'suspended', label: 'Suspended dealers', count: risk.suspended.length, hint: 'Active suspensions on file', tone: 'danger', icon: <ShieldX size={12} color={colors.red} />, route: '/(admin)/dealers?status=suspended' });
    if ((risk.repeat_denied_24h || []).length) out.push({ key: 'denied', label: 'Repeat access denials', count: risk.repeat_denied_24h.length, hint: 'Phones with ≥3 failed attempts · last 24h', tone: 'warn', icon: <BadgeAlert size={12} color={colors.warning} />, route: '/(admin)/security' });
    if ((risk.abnormal_frequency_1h || []).length) out.push({ key: 'freq', label: 'Abnormal bid frequency', count: risk.abnormal_frequency_1h.length, hint: 'Dealers with ≥50 bids in 1h', tone: 'warn', icon: <TrendingUp size={12} color={colors.warning} />, route: '/(admin)/dealers' });
    if ((risk.high_value_spikes_24h || []).length) out.push({ key: 'spike', label: 'High-value spike', count: risk.high_value_spikes_24h.length, hint: 'Single bids ≥ ₹50L · last 24h', tone: 'warn', icon: <Banknote size={12} color={colors.warning} />, route: '/(admin)/security' });
    if ((risk.cancellations_7d || []).length) out.push({ key: 'cancel', label: 'Cancellation pattern', count: risk.cancellations_7d.length, hint: 'Dealers with reversals · last 7d', tone: 'muted', icon: <AlertOctagon size={12} color={colors.silver} />, route: '/(admin)/dealers' });
    if ((risk.inactive_high_limit || []).length) out.push({ key: 'inactive', label: 'Inactive high-limit', count: risk.inactive_high_limit.length, hint: 'Limits ≥ ₹10L, no bids in 30d', tone: 'muted', icon: <Users size={12} color={colors.silver} />, route: '/(admin)/dealers' });
    return out;
  }, [risk]);

  // Aggregate intervention count for the ATTENTION RAIL — combined view
  // of every actionable surface. Rail hides when count = 0.
  const endingSoon = sortedGrid.filter((a) => {
    if (a.status !== 'live') return false;
    const endMs = a.end_time ? new Date(a.end_time).getTime() : 0;
    const left = endMs ? Math.max(0, Math.floor((endMs - now) / 1000)) : 99999;
    return left > 0 && left <= 60;
  }).length;
  const intervention = counts.dispute + counts.paused + counts.pending + pendingDealers + endingSoon;

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
        kicker="OPERATIONS"
        title="Live ops"
        sub={`Desk · ${counts.live} live · ${anomalies.length} ${anomalies.length === 1 ? 'anomaly' : 'anomalies'} · 6s tick`}
      />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* ATTENTION RAIL — only renders when interventions exist. Single-row,
            tap-to-triage. Operators read the platform's blocked work in <2s. */}
        {intervention > 0 && (
          <AttentionRail
            disputes={counts.dispute}
            paused={counts.paused}
            pending={counts.pending}
            pendingDealers={pendingDealers}
            endingSoon={endingSoon}
            onPress={() => {
              if (counts.dispute > 0) router.push('/(admin)/settlement?tab=dispute' as any);
              else if (pendingDealers > 0) router.push('/(admin)/dealers?status=pending' as any);
              else if (counts.pending > 0) router.push('/(admin)/settlement' as any);
            }}
          />
        )}

        {/* COMMAND BAR — replaces the prior 4-tile KPI block + GMV strip with
            one dense status row. 7 micro-cells, mono numerics, no chrome. */}
        <CommandBar
          live={counts.live} paused={counts.paused} pending={counts.pending}
          dispute={counts.dispute} released={counts.released} gmv={gmv} bids={liveBids}
        />

        {/* TRUST & RISK QUICK ACCESS — Reputation + Disputes operator hubs */}
        <View style={styles.trustRow}>
          <TouchableOpacity onPress={() => router.push('/reputation' as any)}
            activeOpacity={0.8} style={styles.trustTile}
            testID="ops-quick-reputation">
            <View style={styles.trustIcon}><ShieldX size={14} color={colors.red} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.trustLabel}>REPUTATION</Text>
              <Text style={styles.trustHint}>Trust scores · restrictions · audit</Text>
            </View>
            <ArrowRight size={14} color={colors.textMuted} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/disputes' as any)}
            activeOpacity={0.8} style={styles.trustTile}
            testID="ops-quick-disputes">
            <View style={styles.trustIcon}><AlertOctagon size={14} color={colors.warning || '#F59E0B'} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.trustLabel}>DISPUTES</Text>
              <Text style={styles.trustHint}>Operator queue · SLA · evidence</Text>
            </View>
            <ArrowRight size={14} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* LIVE AUCTIONS */}
        <View style={styles.sectionHead}>
          <Gavel size={12} color={colors.textChrome} />
          <Text style={styles.sectionTitle}>LIVE AUCTIONS</Text>
          <Text style={styles.sectionMeta}>
            {sortedGrid.length} ROW{sortedGrid.length === 1 ? '' : 'S'} · SORTED BY URGENCY
          </Text>
        </View>
        {loading && grid.length === 0 ? (
          <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>
        ) : sortedGrid.length === 0 ? (
          <View style={styles.emptyCard} testID="live-grid-empty">
            <View style={styles.emptyIcon}><Inbox size={18} color={colors.textChrome} /></View>
            <Text style={styles.emptyTitle}>Desk idle · no monitorable auctions</Text>
            <Text style={styles.emptyBody}>Pipeline is clear. Pull-to-refresh to re-poll, or list a vehicle to spin up the next auction.</Text>
            <TouchableOpacity onPress={() => router.push('/(admin)/launch' as any)} style={styles.emptyCta} testID="live-grid-empty-cta">
              <Text style={styles.emptyCtaText}>+ LIST CAR</Text>
            </TouchableOpacity>
          </View>
        ) : (
          sortedGrid.map((a) => (
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
        <View style={[styles.sectionHead, { marginTop: 18 }]}>
          <Activity size={12} color={colors.textChrome} />
          <Text style={styles.sectionTitle}>SETTLEMENT PIPELINE</Text>
          <TouchableOpacity onPress={() => router.push('/(admin)/settlement' as any)} style={styles.linkBtn} testID="open-settlement-pipeline">
            <Text style={styles.linkBtnText}>OPEN ›</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity activeOpacity={0.85} onPress={() => router.push('/(admin)/settlement' as any)}>
          <View style={styles.pipeline}>
            <PipeStage label="PEND $" count={counts.pending} icon={<Inbox size={11} color={colors.warning} />} tint={colors.warning} />
            <PipeArrow />
            <PipeStage label="PAID" count={counts.payment} icon={<CheckCircle2 size={11} color={colors.silver} />} />
            <PipeArrow />
            <PipeStage label="RELEASED" count={counts.released} icon={<Truck size={11} color={colors.success} />} tint={colors.success} />
            <PipeArrow />
            <PipeStage label="DSPT" count={counts.dispute} icon={<FileWarning size={11} color={colors.red} />} tint={counts.dispute > 0 ? colors.red : undefined} />
          </View>
        </TouchableOpacity>

        {/* DEALER ANOMALY FEED — replaces decorative risk tiles with an
            actionable list. Empty state confirms the desk is clean rather
            than rendering 6 zero-tiles that look broken. */}
        <View style={[styles.sectionHead, { marginTop: 18 }]}>
          <Siren size={12} color={colors.textChrome} />
          <Text style={styles.sectionTitle}>DEALER ANOMALY FEED</Text>
          <Text style={styles.sectionMeta}>
            {anomalies.length === 0 ? 'CLEAN' : `${anomalies.length} ACTIVE`}
          </Text>
        </View>
        {!risk ? (
          <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>
        ) : anomalies.length === 0 ? (
          <View style={styles.cleanCard} testID="risk-clean">
            <View style={styles.cleanDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cleanTitle}>No risk anomalies detected</Text>
              <Text style={styles.cleanBody}>Suspensions, denials, abnormal frequency, high-value spikes, cancellations and inactivity sweeps all clear.</Text>
            </View>
          </View>
        ) : (
          <View style={styles.riskList}>
            {anomalies.map((x, i) => (
              <RiskRow
                key={x.key}
                icon={x.icon}
                label={x.label}
                hint={x.hint}
                count={x.count}
                tone={x.tone}
                last={i === anomalies.length - 1}
                onPress={() => router.push(x.route as any)}
                testID={`risk-row-${x.key}`}
              />
            ))}
          </View>
        )}

        {/* PENDING APPROVALS — operator approval queue badge. Lives below
            anomalies because it's a positive funnel, not a risk surface. */}
        {pendingDealers > 0 && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push('/(admin)/dealers?status=pending' as any)}
            style={styles.pendingTile}
            testID="kpi-pending-approvals"
          >
            <View style={styles.pendingIcon}>
              <UserPlus size={14} color={colors.warning} strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.pendingKicker}>PENDING APPROVALS</Text>
              <Text style={styles.pendingTitle}>
                {pendingDealers} dealer{pendingDealers === 1 ? '' : 's'} awaiting review
              </Text>
            </View>
            <View style={styles.pendingCount}>
              <Text style={styles.pendingCountText}>{pendingDealers}</Text>
            </View>
            <ChevronRight size={14} color={colors.warning} />
          </TouchableOpacity>
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

function Kpi() { return null; } // legacy stub — superseded by CommandBar

/* ------------------------------------------------------------------ *
 * AttentionRail — single dense intervention strip. Surfaces every
 * actionable surface (dispute / paused / pending payment / ending
 * soon / dealer approval) in one tappable line. Hides when 0.
 * ------------------------------------------------------------------ */
function AttentionRail({ disputes, paused, pending, pendingDealers, endingSoon, onPress }: any) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  const tone = disputes > 0 ? colors.red : (endingSoon > 0 ? colors.red : colors.warning);
  const segments: { label: string; n: number; tone?: string }[] = [];
  if (disputes > 0) segments.push({ label: 'DSPT', n: disputes, tone: colors.red });
  if (endingSoon > 0) segments.push({ label: 'ENDING', n: endingSoon, tone: colors.red });
  if (paused > 0) segments.push({ label: 'PAUSED', n: paused, tone: colors.warning });
  if (pending > 0) segments.push({ label: 'PEND $', n: pending, tone: colors.warning });
  if (pendingDealers > 0) segments.push({ label: 'APPROVALS', n: pendingDealers, tone: colors.warning });
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[styles.attnRail, { borderColor: tone + '70' }]} testID="attention-rail">
      <Animated.View style={[styles.attnDot, { backgroundColor: tone, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }]} />
      <Text style={[styles.attnKicker, { color: tone }]}>INTERVENTION</Text>
      <View style={styles.attnSep} />
      {segments.map((s, i) => (
        <View key={s.label} style={styles.attnSeg}>
          <Text style={[styles.attnSegN, { color: s.tone }]}>{s.n}</Text>
          <Text style={styles.attnSegL}>{s.label}</Text>
          {i < segments.length - 1 && <Text style={styles.attnDivider}>·</Text>}
        </View>
      ))}
      <View style={{ flex: 1 }} />
      <Text style={[styles.attnAction, { color: tone }]}>TRIAGE ›</Text>
    </TouchableOpacity>
  );
}

/* ------------------------------------------------------------------ *
 * CommandBar — replaces 4 KPI tiles + GMV strip. One row, 7 cells,
 * mono numerics, no chrome. Hot states (DSPT, PAUSED) flip into a
 * tinted state when count > 0 so operators glance, not read.
 * ------------------------------------------------------------------ */
function CommandBar({ live, paused, pending, dispute, released, gmv, bids }: any) {
  return (
    <View style={styles.cmdBar}>
      <CmdCell label="LIVE"   value={live}     tone={live > 0 ? colors.success : colors.textMuted} />
      <View style={styles.cmdSep} />
      <CmdCell label="PAUSED" value={paused}   tone={paused > 0 ? colors.warning : colors.textMuted} />
      <View style={styles.cmdSep} />
      <CmdCell label="PEND $" value={pending}  tone={pending > 0 ? colors.warning : colors.textMuted} />
      <View style={styles.cmdSep} />
      <CmdCell label="DSPT"   value={dispute}  tone={dispute > 0 ? colors.red : colors.textMuted} hot={dispute > 0} />
      <View style={styles.cmdSep} />
      <CmdCell label="REL'D"  value={released} tone={colors.silver} />
      <View style={styles.cmdSepBold} />
      <CmdCell label="OPEN GMV" value={formatINR(gmv)} tone={colors.red} wide />
      <View style={styles.cmdSep} />
      <CmdCell label="BIDS" value={bids} tone={colors.textChrome} />
    </View>
  );
}
function CmdCell({ label, value, tone, hot, wide }: any) {
  return (
    <View style={[styles.cmdCell, wide && { flex: 1.6 }, hot && styles.cmdCellHot]}>
      <Text style={[styles.cmdCellLabel, { color: tone }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.cmdCellVal, { color: tone === colors.textMuted ? colors.textChrome : tone }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ *
 * AuctionRow — dense urgency-prioritized auction tile. Adds a 3px
 * left edge tint that signals priority at a glance:
 *   • red pulse  → live ending in <60s (cinematic burn-down)
 *   • red solid  → dispute
 *   • amber      → paused / ended_pending_payment
 *   • silver     → live (normal)
 *   • muted      → settled / released / other
 * Internal layout was compressed from 4 stacked rows to 3 dense rows.
 * ------------------------------------------------------------------ */

function AuctionRow({ a, now, onTap, onPause, onResume, onExtend, onForceClose, onCancel }: any) {
  const endMs = a.end_time ? new Date(a.end_time).getTime() : 0;
  const timeLeft = Math.max(0, Math.floor((endMs - now) / 1000));
  const tStr = formatCountdown(timeLeft);
  const ending = timeLeft > 0 && timeLeft <= 60;
  const veryUrgent = timeLeft > 0 && timeLeft <= 300;
  const isLive = a.status === 'live';
  const isPaused = a.status === 'paused';
  const isDispute = a.status === 'dispute';
  const badge = statusBadge(a.status);
  const statusTint = badge.tint;
  const statusLabel = badge.label;

  // Edge tint resolution — encodes urgency into a single 3px column
  // operators read pre-attentively.
  const edgeTint =
    isDispute ? colors.red :
    ending ? colors.red :
    isPaused ? colors.warning :
    veryUrgent ? colors.warning :
    isLive ? colors.success :
    a.status === 'ended_pending_payment' ? colors.warning :
    colors.border;

  // Pulse animation for ENDING (<60s). Subtle background tint so the
  // operator's peripheral vision picks it up while scanning the list.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!ending) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.timing(pulse, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [ending]);

  const pulseBg = ending ? pulse.interpolate({ inputRange: [0, 1], outputRange: ['rgba(185,28,28,0.04)', 'rgba(185,28,28,0.13)'] }) : 'transparent';

  return (
    <TouchableOpacity onPress={onTap} activeOpacity={0.85} style={styles.rowWrap} testID={`live-row-${a.id}`}>
      <Animated.View style={[styles.row, ending && { borderColor: 'rgba(185,28,28,0.5)' }, { backgroundColor: ending ? pulseBg : colors.bgCard }]}>
        {/* Edge urgency strip — 3px tinted column read pre-attentively */}
        <View style={[styles.edge, { backgroundColor: edgeTint }]} />

        {/* Row 1: title + reg + status pill */}
        <View style={styles.rowHead}>
          <Text style={styles.regNoLead}>{a.car?.registration_number || '—'}</Text>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {a.car?.year || ''} {a.car?.make || ''} {a.car?.model || ''}
          </Text>
          <View style={[styles.statusPill, { backgroundColor: statusTint + '14', borderColor: statusTint + '55' }]}>
            <View style={[styles.statusDot, { backgroundColor: statusTint }]} />
            <Text style={[styles.statusText, { color: statusTint }]}>{statusLabel}</Text>
          </View>
        </View>

        {/* Row 2: price | time-left | telemetry (bids · velocity · watchers) */}
        <View style={styles.rowMid}>
          <View style={styles.midCol}>
            <Text style={styles.priceLabel}>HIGHEST</Text>
            <Text style={styles.price}>{formatINR(a.current_bid || 0)}</Text>
            {a.reserve_price ? (
              <Text style={[styles.reserve, { color: a.reserve_met ? colors.success : colors.textMuted }]}>
                {a.reserve_met ? '✓ Reserve met' : `Res ${formatINR(a.reserve_price)}`}
              </Text>
            ) : <Text style={styles.reserve}> </Text>}
          </View>
          <View style={styles.midColRight}>
            <Text style={[styles.priceLabel, ending && { color: colors.red }]}>{ending ? 'ENDING' : 'TIME LEFT'}</Text>
            <Text style={[styles.timer, ending && { color: colors.red }]}>{tStr}</Text>
            <View style={styles.telemetry}>
              <Text style={styles.telN}>{a.total_bids || 0}<Text style={styles.telL}>b</Text></Text>
              {(a.velocity_60s || 0) > 0 && (
                <>
                  <Text style={styles.telSep}>·</Text>
                  <Zap size={9} color={colors.warning} />
                  <Text style={[styles.telN, { color: colors.warning }]}>{a.velocity_60s}<Text style={styles.telL}>/m</Text></Text>
                </>
              )}
              <Text style={styles.telSep}>·</Text>
              <Text style={styles.telN}>{a.watcher_count || 0}<Text style={styles.telL}>w</Text></Text>
              {a.extension_count > 0 && (
                <>
                  <Text style={styles.telSep}>·</Text>
                  <Text style={[styles.telN, { color: colors.warning }]}>+{a.extension_count}<Text style={styles.telL}>ext</Text></Text>
                </>
              )}
            </View>
          </View>
        </View>

        {/* Row 3 (conditional): top bidder fused with cap; only when present */}
        {a.top_bidder ? (
          <View style={styles.bidder}>
            <Text style={styles.bidderLabel}>TOP</Text>
            <Text style={styles.bidderName} numberOfLines={1}>{a.top_bidder.dealership_name || 'Dealer'}</Text>
            <Text style={styles.bidderTrust}>{(a.top_bidder.trust_score ?? 4.5).toFixed(1)}★</Text>
            {a.top_bidder.max_bid_limit && (
              <Text style={styles.bidderCap}>cap {formatINR(a.top_bidder.max_bid_limit)}</Text>
            )}
          </View>
        ) : null}

        {/* Row 4: actions in a single tap-targets row */}
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
          <ChevronRight size={13} color={colors.textMuted} />
        </View>
      </Animated.View>
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

function RiskRow({ icon, label, hint, count, tone, last, onPress, testID }: any) {
  const tint = tone === 'danger' ? colors.red : tone === 'warn' ? colors.warning : colors.silver;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.riskRow, !last && styles.riskRowDivider]}
      testID={testID}
    >
      <View style={[styles.riskRowIcon, { borderColor: tint + '50', backgroundColor: tint + '12' }]}>
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.riskRowLabel} numberOfLines={1}>{label}</Text>
        <Text style={styles.riskRowHint} numberOfLines={1}>{hint}</Text>
      </View>
      <View style={[styles.riskRowCount, { backgroundColor: tint + '15', borderColor: tint + '50' }]}>
        <Text style={[styles.riskRowCountN, { color: tint }]}>{count}</Text>
      </View>
      <ChevronRight size={13} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 80 },

  /* ATTENTION RAIL — 36px tall single-row intervention strip */
  attnRail: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 11, paddingVertical: 9,
    borderRadius: 8, borderWidth: 1,
    backgroundColor: 'rgba(185,28,28,0.05)',
    marginBottom: 10,
  },
  attnDot: { width: 7, height: 7, borderRadius: 4 },
  attnKicker: { fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  attnSep: { width: 1, height: 12, backgroundColor: colors.border, marginHorizontal: 2 },
  attnSeg: { flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  attnSegN: { fontSize: 12, fontWeight: '900', fontVariant: ['tabular-nums'] },
  attnSegL: { color: colors.textChrome, fontSize: 9, fontWeight: '900', letterSpacing: 1.0 },
  attnDivider: { color: colors.textMuted, fontSize: 11, marginHorizontal: 4 },
  attnAction: { fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },

  /* COMMAND BAR — 1 row, 8 cells, replaces 4 KPI tiles + GMV strip */
  cmdBar: {
    flexDirection: 'row', alignItems: 'stretch',
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: colors.bgCard,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: 8, marginBottom: 14,
  },
  cmdCell: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  cmdCellHot: { backgroundColor: 'rgba(185,28,28,0.08)', borderRadius: 4 },
  cmdCellLabel: { fontSize: 8, fontWeight: '900', letterSpacing: 0.9, marginBottom: 3 },
  cmdCellVal: { fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.3 },
  cmdSep: { width: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 },
  cmdSepBold: { width: 1, backgroundColor: 'rgba(185,28,28,0.30)', marginVertical: 2, marginHorizontal: 2 },

  /* SECTION HEADERS */
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 4 },
  sectionTitle: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  sectionMeta: { color: colors.textMuted, fontSize: 9, fontWeight: '900', marginLeft: 'auto', letterSpacing: 1.0, fontVariant: ['tabular-nums'] },
  linkBtn: { marginLeft: 'auto', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 4, borderWidth: 1, borderColor: 'rgba(185,28,28,0.45)', backgroundColor: 'rgba(185,28,28,0.06)' },
  linkBtnText: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 1 },

  /* PENDING APPROVALS tile */
  pendingTile: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 10, borderRadius: 8, backgroundColor: 'rgba(245,158,11,0.06)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.45)', marginTop: 12 },
  pendingIcon: { width: 30, height: 30, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,158,11,0.10)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.40)' },
  pendingKicker: { color: colors.warning, fontSize: 9, fontWeight: '900', letterSpacing: 1.3 },
  pendingTitle: { color: colors.textPrimary, fontSize: 12, fontWeight: '800', marginTop: 2 },
  pendingCount: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.warning, marginRight: 2 },
  pendingCountText: { color: '#0c0c0c', fontSize: 10.5, fontWeight: '900', fontVariant: ['tabular-nums'] },

  /* EMPTY STATES — operator-grade copy, no illustrations */
  loader: { paddingVertical: 22, alignItems: 'center' },
  emptyCard: { padding: 16, alignItems: 'center', borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', marginBottom: 8 },
  emptyIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, marginBottom: 8 },
  emptyTitle: { color: colors.textPrimary, fontSize: 12, fontWeight: '900', letterSpacing: 0.4 },
  emptyBody: { color: colors.textChrome, fontSize: 10.5, fontWeight: '600', textAlign: 'center', marginTop: 3, marginBottom: 10, lineHeight: 14 },
  emptyCta: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 4, backgroundColor: 'rgba(185,28,28,0.10)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.45)' },
  emptyCtaText: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  trustRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, marginTop: 12 },
  trustTile: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  trustIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  trustLabel: { color: colors.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
  trustHint: { color: colors.textMuted, fontSize: 9, fontWeight: '600', letterSpacing: 0.3 },

  /* AUCTION ROW — dense urgency-prioritized tile */
  rowWrap: { marginBottom: 8 },
  row: { padding: 10, paddingLeft: 13, borderRadius: 8, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, position: 'relative', overflow: 'hidden' },
  edge: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  regNoLead: { color: colors.textChrome, fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: 0.6, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  rowTitle: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2.5, borderRadius: 4, borderWidth: 1 },
  statusDot: { width: 5, height: 5, borderRadius: 3 },
  statusText: { fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },

  rowMid: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  midCol: { flex: 1 },
  midColRight: { alignItems: 'flex-end' },
  priceLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  price: { color: colors.textPrimary, fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.4, marginTop: 1 },
  reserve: { fontSize: 9.5, fontWeight: '700', marginTop: 2, letterSpacing: 0.4 },
  timer: { color: colors.textPrimary, fontSize: 18, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.4, marginTop: 1 },

  telemetry: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 },
  telN: { color: colors.textChrome, fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'] },
  telL: { color: colors.textMuted, fontSize: 9, fontWeight: '700' },
  telSep: { color: colors.textMuted, fontSize: 9, marginHorizontal: 1 },

  bidder: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  bidderLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },
  bidderName: { flex: 1, color: colors.textPrimary, fontSize: 11, fontWeight: '800' },
  bidderTrust: { color: colors.warning, fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'] },
  bidderCap: { color: colors.textChrome, fontSize: 9.5, fontWeight: '700', fontVariant: ['tabular-nums'] },

  actions: { flexDirection: 'row', gap: 5, marginTop: 8, alignItems: 'center' },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  actionText: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },

  /* SETTLEMENT PIPELINE — tighter */
  pipeline: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  pipeStage: { flex: 1, padding: 7, borderRadius: 6, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, alignItems: 'center' },
  pipeLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.6, marginTop: 3 },
  pipeCount: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', marginTop: 1, fontVariant: ['tabular-nums'] },
  pipeArrowBox: { width: 12, alignItems: 'center' },

  /* RISK ANOMALY FEED — actionable rows */
  riskList: { backgroundColor: colors.bgCard, borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  riskRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 10 },
  riskRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  riskRowIcon: { width: 26, height: 26, borderRadius: 4, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  riskRowLabel: { color: colors.textPrimary, fontSize: 12, fontWeight: '800', letterSpacing: -0.1 },
  riskRowHint: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 1 },
  riskRowCount: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 4, borderWidth: 1, minWidth: 30, alignItems: 'center' },
  riskRowCountN: { fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },

  /* CLEAN STATE — affirms desk health, no decoration */
  cleanCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11, borderRadius: 8, backgroundColor: 'rgba(16,185,129,0.05)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.35)' },
  cleanDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success, marginLeft: 3 },
  cleanTitle: { color: colors.success, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
  cleanBody: { color: colors.textChrome, fontSize: 10, fontWeight: '600', marginTop: 2, lineHeight: 13 },
});
