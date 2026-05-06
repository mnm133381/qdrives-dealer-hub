/**
 * Settlement Pipeline Tracker — operator Kanban for post-live auction
 * states. Trading-terminal density, no consumer styling. Each column is
 * a settlement state; each card is one auction surfacing risk flags
 * (payment overdue, dispute, suspended dealer, high-value unsettled).
 *
 * Design rules:
 *   • Horizontal Kanban with 6 columns (PENDING $ → PAID → RELEASED →
 *     SETTLED · DISPUTE · CANCELLED).
 *   • Cards are dense, monospaced numerics, no oversized whitespace.
 *   • Tap a card → detail sheet with full timeline, notes, and the
 *     state-appropriate one-tap actions (mark paid / released / settled,
 *     open dispute, add note).
 *   • Risk highlights surfaced inline: payment_overdue (red strip),
 *     suspended_dealer (red dot), dispute (red border), high-value (amber).
 *   • Polling every 6s with load-lock to debounce overlap with WS.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, KeyboardAvoidingView, Platform, TextInput, Pressable,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Inbox, CheckCircle2, Truck, Banknote, FileWarning, Ban,
  AlertOctagon, Clock, ShieldAlert, Flame, ChevronRight, X,
  StickyNote, Send, ShieldX,
} from 'lucide-react-native';
import { colors, radii, formatINR } from '../../src/theme';
import { api } from '../../src/api';
import { AdminHeader } from '../../src/components/AdminHeader';
import { useToast } from '../../src/toast';

type StageKey =
  | 'ended_pending_payment'
  | 'payment_received'
  | 'vehicle_released'
  | 'settled'
  | 'dispute'
  | 'cancelled';

const COLUMNS: Array<{ key: StageKey; label: string; icon: any; tint: string }> = [
  { key: 'ended_pending_payment', label: 'PENDING $',  icon: Inbox,        tint: colors.warning },
  { key: 'payment_received',       label: 'PAID',       icon: CheckCircle2, tint: colors.silver  },
  { key: 'vehicle_released',       label: 'RELEASED',   icon: Truck,        tint: colors.success },
  { key: 'settled',                label: 'SETTLED',    icon: Banknote,     tint: colors.success },
  { key: 'dispute',                label: 'DISPUTE',    icon: FileWarning,  tint: colors.red     },
  { key: 'cancelled',              label: 'CANCELLED',  icon: Ban,          tint: colors.textMuted },
];

const FORWARD_TARGET: Partial<Record<StageKey, { label: string; tint: string; target: StageKey }>> = {
  ended_pending_payment: { label: 'Mark paid',     tint: colors.silver,  target: 'payment_received' },
  payment_received:      { label: 'Mark released', tint: colors.success, target: 'vehicle_released' },
  vehicle_released:      { label: 'Settle',        tint: colors.success, target: 'settled' },
  dispute:               { label: 'Resolve→Settle', tint: colors.success, target: 'settled' },
};

export default function SettlementPipeline() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [meta, setMeta] = useState<{ sla_hours: number; high_value_threshold: number }>({ sla_hours: 48, high_value_threshold: 1000000 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const [now, setNow] = useState(Date.now());
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const r = await api.adminSettlementPipeline(30);
      setItems(r.items || []);
      setCounts(r.by_state || {});
      setMeta({ sla_hours: r.sla_hours, high_value_threshold: r.high_value_threshold });
    } catch (e: any) {
      toast.show(e.message || 'Failed to load pipeline', 'error');
    } finally {
      setLoading(false); loadingRef.current = false;
    }
  }, []);

  useFocusEffect(useCallback(() => {
    load();
    const t = setInterval(load, 6000); // 6s polling, lock-debounced
    return () => clearInterval(t);
  }, [load]));

  // 1s tick for live-age countup display
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // High-level KPIs
  const overdueCount = items.filter((x) => x.payment_overdue).length;
  const disputeCount = counts.dispute || 0;
  const highValueUnsettled = items.filter((x) => x.high_value_unsettled).length;
  const suspendedInPipeline = items.filter((x) => x.suspended_dealer && x.status !== 'settled' && x.status !== 'cancelled').length;

  const totalPipelineValue = items
    .filter((x) => !['settled', 'cancelled'].includes(x.status))
    .reduce((s, x) => s + (x.final_bid || 0), 0);

  const cardsByStage = useMemo(() => {
    const map: Record<StageKey, any[]> = {
      ended_pending_payment: [], payment_received: [], vehicle_released: [],
      settled: [], dispute: [], cancelled: [],
    };
    for (const it of items) if (map[it.status as StageKey]) map[it.status as StageKey].push(it);
    return map;
  }, [items]);

  // Settlement transitions
  const advance = async (auctionId: string, target: string) => {
    try { await api.adminSettlementTransition(auctionId, target); toast.show(`→ ${target.replace(/_/g, ' ')}`, 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };

  return (
    <View style={styles.root}>
      <AdminHeader kicker="Settlement" title="Pipeline" sub="Operator-managed deal flow · audit-attached" />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* Risk strip */}
        <View style={styles.kpiRow}>
          <Kpi label="OVERDUE" value={`${overdueCount}`} icon={<AlertOctagon size={13} color={colors.red} />} tint={overdueCount > 0 ? colors.red : undefined} testID="kpi-overdue" />
          <Kpi label="DISPUTE" value={`${disputeCount}`} icon={<FileWarning size={13} color={colors.red} />} tint={disputeCount > 0 ? colors.red : undefined} testID="kpi-dispute" />
          <Kpi label="HIGH VAL" value={`${highValueUnsettled}`} icon={<Flame size={13} color={colors.warning} />} tint={highValueUnsettled > 0 ? colors.warning : undefined} testID="kpi-highval" />
          <Kpi label="SUSP DLR" value={`${suspendedInPipeline}`} icon={<ShieldX size={13} color={colors.warning} />} tint={suspendedInPipeline > 0 ? colors.warning : undefined} testID="kpi-suspended" />
        </View>

        {/* Open value */}
        <View style={styles.gmvBar}>
          <View style={{ flex: 1 }}>
            <Text style={styles.gmvLabel}>OPEN PIPELINE VALUE</Text>
            <Text style={styles.gmvVal}>{formatINR(totalPipelineValue)}</Text>
          </View>
          <View style={styles.divv} />
          <View style={{ flex: 1 }}>
            <Text style={styles.gmvLabel}>SLA · PAYMENT</Text>
            <Text style={styles.gmvVal}>{meta.sla_hours}h</Text>
          </View>
        </View>

        {/* Loading */}
        {loading && items.length === 0 ? (
          <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>
        ) : items.length === 0 ? (
          <View style={styles.emptyCard} testID="pipeline-empty">
            <View style={styles.emptyIcon}><CheckCircle2 size={20} color={colors.success} /></View>
            <Text style={styles.emptyTitle}>Pipeline clear</Text>
            <Text style={styles.emptyBody}>No auctions awaiting settlement in the last 30 days. Pull-to-refresh to re-poll.</Text>
          </View>
        ) : (
          /* Kanban columns — horizontal scroll */
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.kanbanScroll}>
            {COLUMNS.map((col) => (
              <KanbanColumn
                key={col.key}
                col={col}
                items={cardsByStage[col.key] || []}
                onCardTap={(c) => setSelected(c)}
                onForward={advance}
                now={now}
              />
            ))}
          </ScrollView>
        )}
      </ScrollView>

      {/* Detail bottom sheet */}
      {selected && (
        <DetailSheet
          row={selected}
          onClose={() => setSelected(null)}
          onForward={async (target) => { await advance(selected.id, target); setSelected(null); }}
          onAddNote={async (text) => {
            try {
              const r = await api.adminSettlementAddNote(selected.id, text);
              toast.show('Note added', 'success');
              // Optimistic refresh; pipeline poll will reconcile.
              setSelected({ ...selected, settlement_notes: [...(selected.settlement_notes || []), r.note] });
              load();
            } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
          }}
          onOpenControlPanel={() => { router.push(`/(admin)/auction/${selected.id}` as any); setSelected(null); }}
        />
      )}
    </View>
  );
}

/* =====================================================================
 * Kanban column — vertical stack of dense settlement cards.
 * ===================================================================*/
function KanbanColumn({ col, items, onCardTap, onForward, now }: {
  col: { key: StageKey; label: string; icon: any; tint: string };
  items: any[]; onCardTap: (c: any) => void;
  onForward: (id: string, target: string) => Promise<void>;
  now: number;
}) {
  const Icon = col.icon;
  return (
    <View style={styles.column}>
      <View style={[styles.columnHead, { borderColor: col.tint + '55' }]}>
        <Icon size={14} color={col.tint} strokeWidth={2.4} />
        <Text style={[styles.columnLabel, { color: col.tint }]}>{col.label}</Text>
        <Text style={styles.columnCount}>{items.length}</Text>
      </View>
      <ScrollView style={styles.columnScroll} contentContainerStyle={{ paddingBottom: 16 }}>
        {items.length === 0 ? (
          <View style={styles.columnEmpty}><Text style={styles.columnEmptyText}>—</Text></View>
        ) : (
          items.map((it) => <SettlementCard key={it.id} row={it} onTap={() => onCardTap(it)} onForward={onForward} now={now} />)
        )}
      </ScrollView>
    </View>
  );
}

/* =====================================================================
 * Dense settlement card — one auction.
 * Every key field is glanceable in <2s.
 * ===================================================================*/
function SettlementCard({ row, onTap, onForward, now: _now }: { row: any; onTap: () => void; onForward: (id: string, target: string) => Promise<void>; now: number }) {
  const overdue = row.payment_overdue;
  const isDispute = row.status === 'dispute';
  const isCancelled = row.status === 'cancelled';
  const isHighValue = row.high_value_unsettled;
  const isSuspendedDealer = row.suspended_dealer;
  const fwd = FORWARD_TARGET[row.status as StageKey];

  // Border tint priority: dispute > overdue > high-value > suspended > none
  const borderTint = isDispute ? colors.red
    : overdue ? colors.red
    : isHighValue ? colors.warning
    : isSuspendedDealer ? colors.warning
    : null;

  const dealerName = row.top_bidder?.dealership_name || 'Unbid';
  const trust = row.top_bidder?.trust_score?.toFixed(1) || '—';
  const ageStr = formatAge(row.settlement_age_h);

  return (
    <TouchableOpacity
      onPress={onTap}
      activeOpacity={0.85}
      style={[styles.card, borderTint && { borderColor: borderTint, backgroundColor: borderTint + '08' }]}
      testID={`pipeline-card-${row.id}`}
    >
      {/* Risk strip */}
      {overdue && (
        <View style={[styles.riskStrip, { backgroundColor: colors.red }]}>
          <Text style={styles.riskStripText}>OVERDUE · {ageStr}</Text>
        </View>
      )}
      {!overdue && isDispute && (
        <View style={[styles.riskStrip, { backgroundColor: colors.red }]}>
          <Text style={styles.riskStripText}>DISPUTE OPEN</Text>
        </View>
      )}

      <Text style={styles.cardTitle} numberOfLines={1}>
        {row.car?.year || ''} {row.car?.make || ''} {row.car?.model || ''}
      </Text>
      <Text style={styles.cardReg} numberOfLines={1}>
        {row.car?.registration_number || '—'} · {row.total_bids || 0} bids
      </Text>

      <View style={styles.cardMid}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardKpiLabel}>FINAL BID</Text>
          <Text style={styles.cardPrice}>{formatINR(row.final_bid || 0)}</Text>
          {row.reserve_price ? (
            <Text style={[styles.cardReserve, { color: row.reserve_met ? colors.success : colors.textMuted }]}>
              Reserve {row.reserve_met ? '✓ met' : '✗ missed'}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.cardKpiLabel}>AGE</Text>
          <Text style={[styles.cardAge, overdue && { color: colors.red }]}>{ageStr}</Text>
          {(row.settlement_notes?.length || 0) > 0 && (
            <View style={styles.notesPill}>
              <StickyNote size={10} color={colors.textChrome} />
              <Text style={styles.notesPillText}>{row.settlement_notes.length}</Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.dealerRow}>
        {isSuspendedDealer && <View style={styles.suspendedDot} testID={`susp-dot-${row.id}`} />}
        <Text style={styles.dealerName} numberOfLines={1}>{dealerName}</Text>
        <Text style={styles.dealerTrust}>{trust}★</Text>
        {isHighValue && (
          <View style={styles.highValPill}>
            <Flame size={9} color={colors.warning} />
            <Text style={styles.highValText}>HIGH VAL</Text>
          </View>
        )}
      </View>

      {/* Bottom action bar — one-tap forward + chevron */}
      {(fwd || !isCancelled) && (
        <View style={styles.cardFoot}>
          {fwd ? (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation(); onForward(row.id, fwd.target); }}
              style={[styles.fwdBtn, { borderColor: fwd.tint + '55', backgroundColor: fwd.tint + '12' }]}
              testID={`fwd-${row.id}`}
              activeOpacity={0.85}
            >
              <ChevronRight size={11} color={fwd.tint} />
              <Text style={[styles.fwdBtnText, { color: fwd.tint }]}>{fwd.label}</Text>
            </TouchableOpacity>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          <ChevronRight size={14} color={colors.textMuted} />
        </View>
      )}
    </TouchableOpacity>
  );
}

/* =====================================================================
 * Detail bottom sheet — full timeline + notes + actions.
 * ===================================================================*/
function DetailSheet({ row, onClose, onForward, onAddNote, onOpenControlPanel }: {
  row: any; onClose: () => void;
  onForward: (target: string) => Promise<void>;
  onAddNote: (text: string) => Promise<void>;
  onOpenControlPanel: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const noteValid = note.trim().length >= 5;
  const submitNote = async () => {
    if (!noteValid) return;
    setBusy(true);
    try { await onAddNote(note.trim()); setNote(''); } finally { setBusy(false); }
  };
  const fwd = FORWARD_TARGET[row.status as StageKey];
  // Stages to render in detail timeline
  const stages: Array<{ key: string; label: string; ts?: string }> = [
    { key: 'ended_pending_payment', label: 'Auction ended',  ts: row.ended_at },
    { key: 'payment_received',       label: 'Payment received', ts: row.payment_received_at },
    { key: 'vehicle_released',       label: 'Vehicle released',  ts: row.released_at },
    { key: 'settled',                label: 'Settled',           ts: row.settled_at },
  ];
  if (row.dispute_opened_at) stages.push({ key: 'dispute', label: 'Dispute opened', ts: row.dispute_opened_at });
  if (row.cancelled_at) stages.push({ key: 'cancelled', label: 'Cancelled', ts: row.cancelled_at });

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetKicker}>{(row.status || '').toUpperCase().replace(/_/g, ' ')}</Text>
                <Text style={styles.sheetTitle} numberOfLines={1}>
                  {row.car?.year || ''} {row.car?.make || ''} {row.car?.model || ''}
                </Text>
                <Text style={styles.sheetSub}>{row.car?.registration_number || '—'}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.sheetClose} testID="sheet-close">
                <X size={16} color={colors.textChrome} />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.sheetScroll} contentContainerStyle={{ paddingBottom: 32 }}>
              {/* Headline */}
              <View style={styles.sheetHeadline}>
                <View style={styles.sheetBlock}>
                  <Text style={styles.sheetBlockLabel}>FINAL BID</Text>
                  <Text style={styles.sheetBlockVal}>{formatINR(row.final_bid || 0)}</Text>
                  {row.reserve_price ? (
                    <Text style={[styles.sheetBlockSub, { color: row.reserve_met ? colors.success : colors.textMuted }]}>
                      Reserve {row.reserve_met ? '✓ met' : `✗ ${formatINR(row.reserve_price)}`}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.sheetBlock}>
                  <Text style={styles.sheetBlockLabel}>AGE</Text>
                  <Text style={[styles.sheetBlockVal, row.payment_overdue && { color: colors.red }]}>
                    {formatAge(row.settlement_age_h)}
                  </Text>
                  {row.payment_overdue && <Text style={[styles.sheetBlockSub, { color: colors.red }]}>OVERDUE</Text>}
                </View>
              </View>

              {/* Dealer block */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>WINNING DEALER</Text>
                {row.top_bidder ? (
                  <View style={styles.dealerCard}>
                    <View style={{ flex: 1 }}>
                      <View style={styles.dealerHead}>
                        {row.suspended_dealer && <View style={styles.suspendedDot} />}
                        <Text style={styles.dealerCardName}>{row.top_bidder.dealership_name || row.top_bidder.full_name}</Text>
                      </View>
                      <Text style={styles.dealerCardSub}>
                        {row.top_bidder.full_name || '—'} · {row.top_bidder.city || '—'} · {row.top_bidder.phone || '—'}
                      </Text>
                      <View style={styles.dealerCardMeta}>
                        <Text style={styles.dealerCardTrust}>{row.top_bidder.trust_score?.toFixed(1) || '4.5'}★ trust</Text>
                        {row.top_bidder.max_bid_limit ? (
                          <>
                            <Text style={styles.metaSep}>·</Text>
                            <Text style={styles.dealerCardCap}>cap {formatINR(row.top_bidder.max_bid_limit)}</Text>
                          </>
                        ) : null}
                        {row.suspended_dealer && (
                          <>
                            <Text style={styles.metaSep}>·</Text>
                            <Text style={styles.suspendedText}>SUSPENDED</Text>
                          </>
                        )}
                      </View>
                    </View>
                  </View>
                ) : (
                  <Text style={styles.empty}>No winning bidder.</Text>
                )}
              </View>

              {/* Timeline */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>TIMELINE</Text>
                {stages.map((s, i) => (
                  <View key={s.key + i} style={styles.timelineRow}>
                    <View style={[styles.timelineDot, !!s.ts && styles.timelineDotOn]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.timelineLabel, !s.ts && styles.timelineLabelOff]}>{s.label}</Text>
                      <Text style={styles.timelineTs}>{formatTs(s.ts)}</Text>
                    </View>
                  </View>
                ))}
              </View>

              {/* Cancellation reason if any */}
              {row.cancelled_reason && (
                <View style={[styles.section, styles.cancelSection]}>
                  <Text style={styles.sectionLabel}>CANCELLATION REASON</Text>
                  <Text style={styles.cancelText}>{row.cancelled_reason}</Text>
                </View>
              )}

              {/* Operator notes timeline (newest first) */}
              <View style={styles.section}>
                <Text style={styles.sectionLabel}>OPERATOR NOTES · APPEND-ONLY</Text>
                {(row.settlement_notes || []).length === 0 ? (
                  <Text style={styles.empty}>No notes yet. Add the first one below.</Text>
                ) : (
                  [...(row.settlement_notes || [])].reverse().map((n: any) => (
                    <View key={n.id} style={styles.noteCard}>
                      <View style={styles.noteIcon}><StickyNote size={12} color={colors.textChrome} /></View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.noteText}>{n.text}</Text>
                        <Text style={styles.noteMeta}>
                          {n.operator_name || 'Operator'} · {formatTs(n.created_at)}
                        </Text>
                      </View>
                    </View>
                  ))
                )}
                {/* Add note */}
                <View style={styles.noteInputRow}>
                  <TextInput
                    value={note}
                    onChangeText={setNote}
                    placeholder="Add a settlement note (min 5 chars)"
                    placeholderTextColor={colors.textMuted}
                    style={styles.noteInput}
                    multiline
                    testID="settlement-note-input"
                  />
                  <TouchableOpacity
                    onPress={submitNote}
                    disabled={!noteValid || busy}
                    style={[styles.noteSubmit, (!noteValid || busy) && { opacity: 0.4 }]}
                    testID="settlement-note-submit"
                  >
                    <Send size={14} color={colors.red} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* Action toolbar */}
              <View style={styles.actionBar}>
                {fwd && (
                  <ActionPrimary
                    label={fwd.label}
                    tint={fwd.tint}
                    onPress={() => onForward(fwd.target)}
                    testID="action-forward"
                  />
                )}
                {(['ended_pending_payment', 'payment_received', 'vehicle_released'].includes(row.status)) && (
                  <ActionSecondary
                    label="Open dispute"
                    tint={colors.red}
                    icon={<FileWarning size={13} color={colors.red} />}
                    onPress={() => onForward('dispute')}
                    testID="action-dispute"
                  />
                )}
                <ActionSecondary
                  label="Control panel"
                  tint={colors.silver}
                  icon={<ShieldAlert size={13} color={colors.silver} />}
                  onPress={onOpenControlPanel}
                  testID="action-control-panel"
                />
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* =====================================================================
 * Reusable bits
 * ===================================================================*/
function Kpi({ label, value, icon, tint, testID }: any) {
  return (
    <View style={[styles.kpi, tint && { borderColor: tint + '55', backgroundColor: tint + '0A' }]} testID={testID}>
      <View style={styles.kpiHead}>
        {icon}
        <Text style={[styles.kpiLabel, tint && { color: tint }]}>{label}</Text>
      </View>
      <Text style={styles.kpiVal}>{value}</Text>
    </View>
  );
}
function ActionPrimary({ label, tint, onPress, testID }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.actionPrimary, { backgroundColor: tint }]} testID={testID} activeOpacity={0.85}>
      <Text style={styles.actionPrimaryText}>{label}</Text>
    </TouchableOpacity>
  );
}
function ActionSecondary({ label, tint, icon, onPress, testID }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.actionSecondary, { borderColor: tint + '55' }]} testID={testID} activeOpacity={0.85}>
      {icon}
      <Text style={[styles.actionSecondaryText, { color: tint }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function formatAge(hours: number): string {
  if (!hours || hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
function formatTs(ts?: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return '—'; }
}

const COLUMN_W = 268;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, paddingTop: 6, paddingBottom: 80 },

  kpiRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  kpi: { flex: 1, padding: 11, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kpiHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  kpiLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  kpiVal: { color: colors.textPrimary, fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },

  gmvBar: { flexDirection: 'row', padding: 12, borderRadius: radii.md, backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: 'rgba(185,28,28,0.30)', marginBottom: 14 },
  gmvLabel: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  gmvVal: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'], letterSpacing: -0.3 },
  divv: { width: 1, height: 32, backgroundColor: colors.border, marginHorizontal: 14, alignSelf: 'center' },

  loader: { paddingVertical: 30, alignItems: 'center' },
  emptyCard: { padding: 22, alignItems: 'center', borderRadius: radii.lg, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, marginBottom: 10 },
  emptyTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', letterSpacing: 0.4 },
  emptyBody: { color: colors.textChrome, fontSize: 11.5, fontWeight: '600', textAlign: 'center', marginTop: 4, lineHeight: 16 },

  /* Kanban */
  kanbanScroll: { gap: 10, paddingBottom: 8 },
  column: { width: COLUMN_W },
  columnHead: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 8, backgroundColor: colors.bgCard, borderWidth: 1, marginBottom: 8 },
  columnLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  columnCount: { color: colors.textPrimary, fontSize: 12, fontWeight: '900', marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  columnScroll: { maxHeight: 580 },
  columnEmpty: { padding: 18, alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', backgroundColor: 'transparent' },
  columnEmptyText: { color: colors.textMuted, fontSize: 13, fontWeight: '900', letterSpacing: 2 },

  /* Card */
  card: { borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, padding: 11, marginBottom: 8, overflow: 'hidden' },
  riskStrip: { marginHorizontal: -11, marginTop: -11, marginBottom: 8, paddingVertical: 4, alignItems: 'center' },
  riskStripText: { color: '#fff', fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  cardTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
  cardReg: { color: colors.textChrome, fontSize: 10.5, fontWeight: '700', marginTop: 2, fontVariant: ['tabular-nums'] },
  cardMid: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 9, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.border },
  cardKpiLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },
  cardPrice: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'], letterSpacing: -0.3 },
  cardReserve: { fontSize: 10, fontWeight: '700', marginTop: 2 },
  cardAge: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'] },
  notesPill: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 4, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 999, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  notesPillText: { color: colors.textChrome, fontSize: 9.5, fontWeight: '900', fontVariant: ['tabular-nums'] },

  dealerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.border },
  suspendedDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.red },
  dealerName: { flex: 1, color: colors.textPrimary, fontSize: 11.5, fontWeight: '700' },
  dealerTrust: { color: colors.warning, fontSize: 10.5, fontWeight: '900', fontVariant: ['tabular-nums'] },
  highValPill: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 999, backgroundColor: 'rgba(245,158,11,0.10)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)' },
  highValText: { color: colors.warning, fontSize: 8, fontWeight: '900', letterSpacing: 0.7 },

  cardFoot: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 9 },
  fwdBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, borderWidth: 1, flex: 1 },
  fwdBtnText: { fontSize: 10.5, fontWeight: '900', letterSpacing: 0.4 },

  /* Sheet */
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bgElevated, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1.5, borderColor: 'rgba(185,28,28,0.4)', maxHeight: '92%' },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginVertical: 8 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  sheetKicker: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  sheetTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '900', marginTop: 2, letterSpacing: -0.4 },
  sheetSub: { color: colors.textChrome, fontSize: 11.5, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'] },
  sheetClose: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  sheetScroll: { paddingHorizontal: 18, paddingTop: 14 },

  sheetHeadline: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  sheetBlock: { flex: 1, padding: 12, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: 'rgba(185,28,28,0.25)' },
  sheetBlockLabel: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  sheetBlockVal: { color: colors.textPrimary, fontSize: 22, fontWeight: '900', marginTop: 4, fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  sheetBlockSub: { fontSize: 11, fontWeight: '800', marginTop: 4, letterSpacing: 0.4 },

  section: { marginBottom: 16 },
  sectionLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4, marginBottom: 8 },

  dealerCard: { padding: 11, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  dealerHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dealerCardName: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  dealerCardSub: { color: colors.textChrome, fontSize: 11.5, fontWeight: '600', marginTop: 4 },
  dealerCardMeta: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6, flexWrap: 'wrap' },
  dealerCardTrust: { color: colors.warning, fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  dealerCardCap: { color: colors.textChrome, fontSize: 10.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  metaSep: { color: colors.textMuted, fontSize: 11 },
  suspendedText: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1 },
  empty: { color: colors.textMuted, fontSize: 12, fontWeight: '600', paddingVertical: 4 },

  timelineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 6 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4, backgroundColor: colors.border },
  timelineDotOn: { backgroundColor: colors.success },
  timelineLabel: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  timelineLabelOff: { color: colors.textMuted },
  timelineTs: { color: colors.textChrome, fontSize: 10.5, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },

  cancelSection: { padding: 11, borderRadius: 10, backgroundColor: 'rgba(185,28,28,0.06)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.30)' },
  cancelText: { color: colors.textPrimary, fontSize: 12, fontWeight: '600', lineHeight: 17 },

  noteCard: { flexDirection: 'row', gap: 9, padding: 10, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginBottom: 7 },
  noteIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  noteText: { color: colors.textPrimary, fontSize: 12, fontWeight: '600', lineHeight: 16 },
  noteMeta: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 4, fontVariant: ['tabular-nums'] },
  noteInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 8 },
  noteInput: { flex: 1, color: colors.textPrimary, fontSize: 12.5, fontWeight: '500', minHeight: 44, padding: 10, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: 10, textAlignVertical: 'top' },
  noteSubmit: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(185,28,28,0.10)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.45)' },

  actionBar: { flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  actionPrimary: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 999, alignItems: 'center', flex: 1, minWidth: 140 },
  actionPrimaryText: { color: '#fff', fontSize: 12.5, fontWeight: '900', letterSpacing: 0.6 },
  actionSecondary: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 999, borderWidth: 1, backgroundColor: colors.bgCard },
  actionSecondaryText: { fontSize: 11.5, fontWeight: '900', letterSpacing: 0.4 },
});
