/**
 * Operator Auction Control Panel.
 *
 * Drilldown forensic view for a single auction. Shows the full bid book
 * (including cancelled bids with reversal trail), timestamps, settlement
 * timeline, and the complete operator action toolbar.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Platform, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import {
  ArrowLeft, Pause, Play, FastForward, Flame, ShieldX, Gavel, Clock,
  CheckCircle2, Truck, Inbox, FileWarning, Ban, Users, AlertOctagon,
  ChevronRight, Banknote, RotateCcw, X,
} from 'lucide-react-native';
import { colors, radii, formatINR } from '../../../src/theme';
import { api } from '../../../src/api';
import { ReasonModal } from '../../../src/components/ReasonModal';
import { useToast } from '../../../src/toast';

const SETTLEMENT_STAGES = [
  { key: 'ended_pending_payment', label: 'PENDING $', icon: Inbox, tint: colors.warning, ts: 'ended_at' },
  { key: 'payment_received', label: 'PAID', icon: CheckCircle2, tint: colors.silver, ts: 'payment_received_at' },
  { key: 'vehicle_released', label: 'RELEASED', icon: Truck, tint: colors.success, ts: 'released_at' },
  { key: 'settled', label: 'SETTLED', icon: CheckCircle2, tint: colors.success, ts: 'settled_at' },
];

export default function AuctionControlPanel() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  const [reasonModal, setReasonModal] = useState<
    | { kind: 'pause' | 'force_close' | 'cancel' }
    | { kind: 'cancel_bid'; bidId: string; amount: number }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const d = await api.adminAuctionControlPanel(String(id));
      setData(d);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load', 'error');
    } finally { setLoading(false); loadingRef.current = false; }
  }, [id]);

  useFocusEffect(useCallback(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]));

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (loading || !data) {
    return <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>;
  }

  const a = data.auction;
  const car = data.car;
  const status = a.status;
  const isLive = status === 'live';
  const isPaused = status === 'paused';
  const endMs = a.end_time ? new Date(a.end_time).getTime() : 0;
  const timeLeft = Math.max(0, Math.floor((endMs - now) / 1000));
  const m = Math.floor(timeLeft / 60), s = timeLeft % 60;
  const tStr = `${m}:${s.toString().padStart(2, '0')}`;

  const onResume = async () => { try { await api.adminResumeAuction(a.id); toast.show('Resumed', 'success'); load(); } catch (e: any) { toast.show(e.message, 'error'); } };
  const onExtend = async (sec: number) => { try { await api.adminExtendAuction(a.id, sec, `Quick +${sec}s`); toast.show(`Extended +${sec}s`, 'success'); load(); } catch (e: any) { toast.show(e.message, 'error'); } };

  const submitReason = async (reason: string) => {
    if (!reasonModal) return;
    setBusy(true);
    try {
      if (reasonModal.kind === 'pause') await api.adminPauseAuction(a.id, reason);
      else if (reasonModal.kind === 'force_close') await api.adminForceClose(a.id, reason);
      else if (reasonModal.kind === 'cancel') await api.adminCancelAuction(a.id, reason);
      else if (reasonModal.kind === 'cancel_bid') await api.adminCancelBid(a.id, reasonModal.bidId, reason);
      toast.show('Done', 'success');
      setReasonModal(null);
      load();
    } catch (e: any) { toast.show(e.message, 'error'); }
    finally { setBusy(false); }
  };

  const advanceSettlement = async (target: string) => {
    try { await api.adminSettlementTransition(a.id, target); toast.show(`→ ${target}`, 'success'); load(); }
    catch (e: any) { toast.show(e.message, 'error'); }
  };

  return (
    <View style={styles.root}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="control-back">
          <ArrowLeft size={18} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>CONTROL PANEL</Text>
          <Text style={styles.title} numberOfLines={1}>{`${car.year || ''} ${car.make || ''} ${car.model || ''}`.trim()}</Text>
        </View>
        <View style={[styles.statusPill, statusStyle(status).pill]}>
          <View style={[styles.statusDot, statusStyle(status).dot]} />
          <Text style={[styles.statusText, statusStyle(status).text]}>{(status || '').toUpperCase().replace(/_/g, ' ')}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.red} />}>
        {/* Headline */}
        <View style={styles.headlineRow}>
          <View style={styles.headBlock}>
            <Text style={styles.headLabel}>HIGHEST BID</Text>
            <Text style={styles.priceBig}>{formatINR(a.current_bid || 0)}</Text>
            {a.reserve_price ? (
              <Text style={[styles.reserve, { color: a.current_bid >= a.reserve_price ? colors.success : colors.textMuted }]}>
                Reserve {a.current_bid >= a.reserve_price ? 'met' : `${formatINR(a.reserve_price)}`}
              </Text>
            ) : null}
          </View>
          <View style={styles.headBlock}>
            <Text style={styles.headLabel}>{isLive || isPaused ? 'TIME LEFT' : 'STATUS'}</Text>
            <Text style={[styles.priceBig, timeLeft > 0 && timeLeft <= 60 && { color: colors.red }]}>
              {(isLive || isPaused) ? tStr : (status || '').replace(/_/g, ' ')}
            </Text>
            {a.extension_count > 0 && <Text style={styles.extCount}>+{a.extension_count} extensions</Text>}
          </View>
        </View>

        {/* Operator toolbar */}
        <View style={styles.toolbar}>
          {isLive && (
            <>
              <ToolBtn label="Pause" icon={<Pause size={13} color={colors.warning} />} tint={colors.warning} onPress={() => setReasonModal({ kind: 'pause' })} testID="control-pause" />
              <ToolBtn label="+60s" icon={<FastForward size={13} color={colors.silver} />} onPress={() => onExtend(60)} testID="control-extend-60" />
              <ToolBtn label="+5m" icon={<FastForward size={13} color={colors.silver} />} onPress={() => onExtend(300)} testID="control-extend-300" />
              <ToolBtn label="Force-close" icon={<Flame size={13} color={colors.red} />} tint={colors.red} onPress={() => setReasonModal({ kind: 'force_close' })} testID="control-fc" />
              <ToolBtn label="Cancel" icon={<ShieldX size={13} color={colors.red} />} tint={colors.red} onPress={() => setReasonModal({ kind: 'cancel' })} testID="control-cancel" />
            </>
          )}
          {isPaused && (
            <>
              <ToolBtn label="Resume" icon={<Play size={13} color={colors.success} />} tint={colors.success} onPress={onResume} testID="control-resume" />
              <ToolBtn label="Force-close" icon={<Flame size={13} color={colors.red} />} tint={colors.red} onPress={() => setReasonModal({ kind: 'force_close' })} testID="control-fc" />
              <ToolBtn label="Cancel" icon={<ShieldX size={13} color={colors.red} />} tint={colors.red} onPress={() => setReasonModal({ kind: 'cancel' })} testID="control-cancel" />
            </>
          )}
        </View>

        {/* Settlement timeline */}
        <View style={styles.section}>
          <View style={styles.sectionHead}><Truck size={13} color={colors.textChrome} /><Text style={styles.sectionTitle}>SETTLEMENT TIMELINE</Text></View>
          <View style={styles.timeline}>
            {SETTLEMENT_STAGES.map((stage, i) => {
              const StageIcon = stage.icon;
              const ts = a[stage.ts];
              const idx = SETTLEMENT_STAGES.findIndex((s) => s.key === status);
              const reached = idx >= 0 && i <= idx;
              const tint = reached ? stage.tint : colors.textMuted;
              return (
                <React.Fragment key={stage.key}>
                  <View style={[styles.stageNode, reached && { borderColor: tint, backgroundColor: tint + '14' }]}>
                    <StageIcon size={14} color={tint} />
                    <Text style={[styles.stageLabel, { color: tint }]}>{stage.label}</Text>
                    {ts && <Text style={styles.stageTs}>{new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</Text>}
                  </View>
                  {i < SETTLEMENT_STAGES.length - 1 && <View style={[styles.stageBar, reached && { backgroundColor: tint }]} />}
                </React.Fragment>
              );
            })}
          </View>
          {/* Forward-only settlement controls */}
          <View style={styles.settlementControls}>
            {status === 'ended_pending_payment' && (
              <ToolBtn label="Mark paid" icon={<CheckCircle2 size={13} color={colors.silver} />} onPress={() => advanceSettlement('payment_received')} testID="settle-paid" />
            )}
            {status === 'payment_received' && (
              <ToolBtn label="Mark released" icon={<Truck size={13} color={colors.success} />} tint={colors.success} onPress={() => advanceSettlement('vehicle_released')} testID="settle-released" />
            )}
            {status === 'vehicle_released' && (
              <ToolBtn label="Settle" icon={<CheckCircle2 size={13} color={colors.success} />} tint={colors.success} onPress={() => advanceSettlement('settled')} testID="settle-final" />
            )}
            {(status === 'ended_pending_payment' || status === 'payment_received' || status === 'vehicle_released') && (
              <ToolBtn label="Open dispute" icon={<FileWarning size={13} color={colors.red} />} tint={colors.red} onPress={() => advanceSettlement('dispute')} testID="settle-dispute" />
            )}
            {status === 'dispute' && (
              <ToolBtn label="Resolve→Settle" icon={<CheckCircle2 size={13} color={colors.success} />} tint={colors.success} onPress={() => advanceSettlement('settled')} testID="settle-resolve" />
            )}
          </View>
        </View>

        {/* Bid book — forensic view */}
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Gavel size={13} color={colors.textChrome} />
            <Text style={styles.sectionTitle}>BID BOOK · APPEND-ONLY</Text>
            <Text style={styles.sectionCount}>{data.bids?.length || 0}</Text>
          </View>
          {data.bids?.length === 0 ? (
            <Text style={styles.empty}>No bids placed yet.</Text>
          ) : data.bids.map((b: any) => (
            <View key={b.id} style={[styles.bidRow, b.cancelled && styles.bidRowCancelled]}>
              <View style={[styles.bidDot, b.cancelled ? { backgroundColor: colors.red } : a.top_bidder_id === b.dealer_id && !b.cancelled ? { backgroundColor: colors.success } : { backgroundColor: colors.textMuted }]} />
              <View style={{ flex: 1 }}>
                <View style={styles.bidLine}>
                  <Text style={[styles.bidAmount, b.cancelled && styles.strike]}>{formatINR(b.amount)}</Text>
                  {b.cancelled && (
                    <View style={styles.cancelTag}><X size={9} color={colors.red} /><Text style={styles.cancelTagText}>CANCELLED</Text></View>
                  )}
                  {!b.cancelled && a.top_bidder_id === b.dealer_id && (
                    <View style={styles.topTag}><Text style={styles.topTagText}>TOP</Text></View>
                  )}
                </View>
                <Text style={styles.bidMeta} numberOfLines={1}>
                  {b.dealer?.dealership_name || 'Dealer'} · {b.dealer?.trust_score?.toFixed(1) || '4.5'}★ · {b.dealer?.city || '—'}
                </Text>
                {b.cancelled && b.cancellation_reason && (
                  <Text style={styles.cancelReason}>reason: {b.cancellation_reason}</Text>
                )}
                <Text style={styles.bidTs}>
                  {new Date(b.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                </Text>
              </View>
              {!b.cancelled && (
                <TouchableOpacity
                  onPress={() => setReasonModal({ kind: 'cancel_bid', bidId: b.id, amount: b.amount })}
                  style={styles.bidCancelBtn} testID={`bid-cancel-${b.id}`}
                >
                  <X size={13} color={colors.red} />
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>

        {/* Reversal log */}
        {data.reversals?.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHead}>
              <RotateCcw size={13} color={colors.red} />
              <Text style={[styles.sectionTitle, { color: colors.red }]}>REVERSAL LOG</Text>
              <Text style={[styles.sectionCount, { color: colors.red }]}>{data.reversals.length}</Text>
            </View>
            {data.reversals.map((r: any) => (
              <View key={r.id} style={styles.reversal}>
                <View style={styles.reversalIcon}><RotateCcw size={11} color={colors.red} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.reversalAmount}>—{formatINR(r.amount)}</Text>
                  <Text style={styles.reversalReason}>{r.reason}</Text>
                  <Text style={styles.reversalMeta}>
                    bid:{(r.bid_id || '').slice(0, 8)} · op:{(r.operator_id || '').slice(0, 8)} · ip:{r.operator_ip || '—'}
                  </Text>
                  <Text style={styles.bidTs}>
                    {new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {reasonModal && (
        <ReasonModal
          visible
          title={
            reasonModal.kind === 'pause' ? 'Pause this auction'
              : reasonModal.kind === 'force_close' ? 'Force-close this auction'
              : reasonModal.kind === 'cancel' ? 'Cancel this auction'
              : `Cancel bid — ${formatINR((reasonModal as any).amount)}`
          }
          cta={
            reasonModal.kind === 'pause' ? 'Pause'
              : reasonModal.kind === 'force_close' ? 'Force-close'
              : reasonModal.kind === 'cancel' ? 'Cancel auction'
              : 'Cancel bid'
          }
          danger={reasonModal.kind !== 'pause'}
          busy={busy}
          onClose={() => setReasonModal(null)}
          onSubmit={submitReason}
        />
      )}
    </View>
  );
}

function ToolBtn({ icon, label, onPress, tint, testID }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.toolBtn, tint && { borderColor: tint + '55', backgroundColor: tint + '12' }]} activeOpacity={0.85} testID={testID}>
      {icon}
      <Text style={[styles.toolText, tint && { color: tint }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function statusStyle(status: string) {
  if (status === 'live') return { pill: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' }, dot: { backgroundColor: colors.success }, text: { color: colors.success } };
  if (status === 'paused') return { pill: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' }, dot: { backgroundColor: colors.warning }, text: { color: colors.warning } };
  if (status === 'cancelled' || status === 'dispute') return { pill: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' }, dot: { backgroundColor: colors.red }, text: { color: colors.red } };
  if (status === 'settled') return { pill: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' }, dot: { backgroundColor: colors.success }, text: { color: colors.success } };
  return { pill: { backgroundColor: 'rgba(160,160,160,0.10)', borderColor: 'rgba(160,160,160,0.4)' }, dot: { backgroundColor: colors.silver }, text: { color: colors.silver } };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: Platform.OS === 'ios' ? 60 : 36, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(185,28,28,0.20)' },
  iconBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kicker: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginTop: 2, letterSpacing: -0.3 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },

  body: { padding: 16, paddingBottom: 80 },
  headlineRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  headBlock: { flex: 1, padding: 13, borderRadius: radii.lg, backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: 'rgba(185,28,28,0.30)' },
  headLabel: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  priceBig: { color: colors.textPrimary, fontSize: 26, fontWeight: '900', marginTop: 6, fontVariant: ['tabular-nums'], letterSpacing: -0.6 },
  reserve: { fontSize: 11, fontWeight: '700', marginTop: 2, letterSpacing: 0.4 },
  extCount: { color: colors.warning, fontSize: 11, fontWeight: '700', marginTop: 4, letterSpacing: 0.4 },

  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginBottom: 18 },
  toolBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard },
  toolText: { color: colors.textPrimary, fontSize: 11.5, fontWeight: '900', letterSpacing: 0.4 },

  section: { marginBottom: 18 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  sectionTitle: { color: colors.textChrome, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  sectionCount: { color: colors.red, fontSize: 11, fontWeight: '900', marginLeft: 'auto' },
  empty: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textAlign: 'center', paddingVertical: 18 },

  timeline: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  stageNode: { flex: 1, alignItems: 'center', padding: 9, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  stageLabel: { fontSize: 8.5, fontWeight: '900', letterSpacing: 0.6, marginTop: 4 },
  stageTs: { color: colors.textMuted, fontSize: 9, marginTop: 3, fontVariant: ['tabular-nums'] },
  stageBar: { width: 8, height: 2, backgroundColor: colors.border, marginHorizontal: 2 },
  settlementControls: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },

  bidRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginBottom: 7 },
  bidRowCancelled: { backgroundColor: 'rgba(185,28,28,0.05)', borderColor: 'rgba(185,28,28,0.25)' },
  bidDot: { width: 8, height: 8, borderRadius: 4 },
  bidLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  bidAmount: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] },
  strike: { textDecorationLine: 'line-through', color: colors.textMuted },
  cancelTag: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.15)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)' },
  cancelTagText: { color: colors.red, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.7 },
  topTag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: 'rgba(16,185,129,0.15)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.4)' },
  topTagText: { color: colors.success, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.7 },
  bidMeta: { color: colors.textChrome, fontSize: 10.5, fontWeight: '600', marginTop: 3 },
  cancelReason: { color: colors.warning, fontSize: 10, marginTop: 2, fontStyle: 'italic' },
  bidTs: { color: colors.textMuted, fontSize: 9.5, marginTop: 2, fontVariant: ['tabular-nums'] },
  bidCancelBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(185,28,28,0.10)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.30)' },

  reversal: { flexDirection: 'row', gap: 10, padding: 11, borderRadius: 8, backgroundColor: 'rgba(185,28,28,0.06)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.30)', marginBottom: 7 },
  reversalIcon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(185,28,28,0.15)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.30)' },
  reversalAmount: { color: colors.red, fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
  reversalReason: { color: colors.textPrimary, fontSize: 11.5, marginTop: 2, fontWeight: '600' },
  reversalMeta: { color: colors.textMuted, fontSize: 9.5, marginTop: 3, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
});
