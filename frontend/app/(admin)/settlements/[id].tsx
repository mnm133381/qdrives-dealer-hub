/**
 * Settlement Operator Detail — full per-deal command panel.
 *
 * Renders the entire 16-state lifecycle for one settlement:
 *   • Live state + prior_state header with audit-grade timestamps
 *   • Vehicle / dealer / commercial summary (winning amount, 5% deposit)
 *   • State-aware action panel — only the transitions VALID from the
 *     current state are surfaced. No silent transitions.
 *   • Visit scheduling, refund, full-payment, vehicle-delivered, complete
 *     dialogs with structured payloads.
 *   • Internal notes (operator-only) + dealer-visible messages
 *     (append-only, ledger-style).
 *   • Full audit trail with actor_id + reason + meta.
 *   • Operator override actions: flag_no_show, mark_delayed, mark_dispute,
 *     resume_to_review.
 *
 * Design: dark operational UI, monospaced timestamps, no flashy CTAs,
 * trade-desk density. No fintech/checkout vibes.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Modal, Pressable, KeyboardAvoidingView, Platform, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft, Banknote, ShieldCheck, MapPin, ClipboardCheck, RotateCcw,
  Wallet, PackageCheck, CheckCircle2, AlertTriangle, Pause, FileWarning,
  Ban, MessageSquare, StickyNote, FileImage, Clock, ChevronRight,
  RefreshCw, X, Send,
} from 'lucide-react-native';
import { colors, radii, formatINR, formatINRFull } from '../../../src/theme';
import { api } from '../../../src/api';
import { useToast } from '../../../src/toast';

const STATE_META: Record<string, { label: string; tint: string; sub?: string }> = {
  auction_won:                  { label: 'AUCTION WON',                tint: colors.silver,  sub: 'Auto-advancing to operator queue' },
  awaiting_operator_review:     { label: 'AWAITING OPERATOR REVIEW',   tint: colors.warning, sub: 'Operator must request the 5% deposit to proceed' },
  deposit_requested:            { label: 'DEPOSIT REQUESTED',          tint: colors.warning, sub: 'Buyer to upload proof of payment' },
  deposit_under_verification:   { label: 'DEPOSIT UNDER VERIFICATION', tint: colors.warning, sub: 'Operator to verify proof or reject' },
  deposit_verified:             { label: 'DEPOSIT VERIFIED',           tint: colors.success, sub: 'Operator to schedule physical visit' },
  visit_scheduled:              { label: 'VISIT SCHEDULED',            tint: colors.info,    sub: 'Awaiting on-site inspection' },
  inspection_completed:         { label: 'INSPECTION COMPLETED',       tint: colors.info,    sub: 'Choose: refund OR request full payment' },
  refund_approved:              { label: 'REFUND APPROVED',            tint: colors.warning, sub: 'Operator to mark refund as completed' },
  refund_completed:             { label: 'REFUND COMPLETED',           tint: colors.silver,  sub: 'Terminal · deposit refunded' },
  full_payment_requested:       { label: 'FULL PAYMENT REQUESTED',     tint: colors.warning, sub: 'Awaiting balance payment from buyer' },
  full_payment_received:        { label: 'FULL PAYMENT RECEIVED',      tint: colors.success, sub: 'Operator to mark vehicle as delivered' },
  vehicle_delivered:            { label: 'VEHICLE DELIVERED',          tint: colors.success, sub: 'Final close pending' },
  completed:                    { label: 'COMPLETED',                  tint: colors.success, sub: 'Terminal · deal closed' },
  no_show_review:               { label: 'NO-SHOW REVIEW',             tint: colors.red,     sub: 'Operator must resume or close out' },
  settlement_delayed:           { label: 'SETTLEMENT DELAYED',         tint: colors.red,     sub: 'Flagged delayed — operator action required' },
  dispute:                      { label: 'DISPUTE',                    tint: colors.red,     sub: 'Linked dispute open — see disputes console' },
};

type ActionKey =
  | 'request_deposit' | 'reject_proof' | 'verify_deposit' | 'schedule_visit'
  | 'mark_inspection_done' | 'approve_refund' | 'mark_refund_completed'
  | 'request_full_payment' | 'mark_full_payment_received' | 'mark_vehicle_delivered'
  | 'complete_deal' | 'flag_no_show' | 'mark_delayed' | 'mark_dispute' | 'resume_to_review';

type ActionDef = {
  key: ActionKey; label: string; icon: any; tone: 'primary' | 'success' | 'warn' | 'danger';
  needsModal?: boolean;
};

// Primary action(s) per state — what the operator should do next.
const STATE_PRIMARY_ACTIONS: Partial<Record<string, ActionDef[]>> = {
  awaiting_operator_review: [
    { key: 'request_deposit', label: 'Request 5% Deposit', icon: Banknote, tone: 'primary', needsModal: true },
  ],
  deposit_requested: [
    { key: 'request_deposit', label: 'Resend Deposit Request', icon: RefreshCw, tone: 'warn', needsModal: true },
  ],
  deposit_under_verification: [
    { key: 'verify_deposit', label: 'Verify Deposit', icon: ShieldCheck, tone: 'success' },
    { key: 'reject_proof', label: 'Reject Proof', icon: X, tone: 'danger' },
  ],
  deposit_verified: [
    { key: 'schedule_visit', label: 'Schedule Visit', icon: MapPin, tone: 'primary', needsModal: true },
  ],
  visit_scheduled: [
    { key: 'mark_inspection_done', label: 'Mark Inspection Done', icon: ClipboardCheck, tone: 'primary' },
  ],
  inspection_completed: [
    { key: 'request_full_payment', label: 'Request Full Payment', icon: Wallet, tone: 'primary', needsModal: true },
    { key: 'approve_refund', label: 'Approve Refund', icon: RotateCcw, tone: 'warn', needsModal: true },
  ],
  refund_approved: [
    { key: 'mark_refund_completed', label: 'Mark Refund Completed', icon: CheckCircle2, tone: 'success', needsModal: true },
  ],
  full_payment_requested: [
    { key: 'mark_full_payment_received', label: 'Mark Full Payment Received', icon: ShieldCheck, tone: 'success', needsModal: true },
  ],
  full_payment_received: [
    { key: 'mark_vehicle_delivered', label: 'Mark Vehicle Delivered', icon: PackageCheck, tone: 'primary' },
  ],
  vehicle_delivered: [
    { key: 'complete_deal', label: 'Close Deal', icon: CheckCircle2, tone: 'success' },
  ],
  no_show_review: [
    { key: 'resume_to_review', label: 'Resume to Operator Queue', icon: RotateCcw, tone: 'primary' },
  ],
  settlement_delayed: [
    { key: 'resume_to_review', label: 'Resume to Operator Queue', icon: RotateCcw, tone: 'primary' },
  ],
  dispute: [
    { key: 'resume_to_review', label: 'Resume Settlement', icon: RotateCcw, tone: 'primary' },
  ],
};

export default function SettlementDetail() {
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'audit' | 'notes' | 'messages'>('audit');
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ kind: ActionKey; def: ActionDef } | null>(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const r = await api.adminSettlementDetail(id);
      setData(r);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load settlement', 'error');
    } finally {
      setLoading(false); loadingRef.current = false;
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const transition = useCallback(async (action: ActionKey, payload?: any, reason?: string) => {
    if (!id) return;
    setBusy(true);
    try {
      await api.adminSettlementTransitionV2(id, action, payload, reason);
      toast.show(`→ ${action.replace(/_/g, ' ')}`, 'success');
      await load();
    } catch (e: any) {
      toast.show(e.message || 'Action failed', 'error');
    } finally {
      setBusy(false); setModal(null);
    }
  }, [id, load]);

  const meta = data ? STATE_META[data.state] : null;
  const primaryActions = data ? (STATE_PRIMARY_ACTIONS[data.state] || []) : [];

  const isTerminal = data?.state === 'completed' || data?.state === 'refund_completed';

  if (loading || !data) {
    return (
      <View style={styles.root}>
        <View style={styles.loaderWrap}><ActivityIndicator color={colors.red} /></View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="settlement-back">
          <ArrowLeft size={18} color={colors.textChrome} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>SETTLEMENT · {data.id?.slice(0, 8).toUpperCase()}</Text>
          <Text style={styles.title} numberOfLines={1}>
            {data.snapshot?.car_year} {data.snapshot?.car_make} {data.snapshot?.car_model}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* State strip */}
        <View style={[styles.stateStrip, { borderColor: meta!.tint + '88' }]}>
          <View style={[styles.stateDot, { backgroundColor: meta!.tint }]} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.stateLabel, { color: meta!.tint }]}>{meta!.label}</Text>
            {meta!.sub && <Text style={styles.stateSub}>{meta!.sub}</Text>}
            {data.prior_state && (
              <Text style={styles.priorState}>FROM · {data.prior_state.replace(/_/g, ' ')}</Text>
            )}
          </View>
        </View>

        {/* Headline numbers */}
        <View style={styles.numbersRow}>
          <View style={styles.numberCard}>
            <Text style={styles.numberLabel}>WINNING BID</Text>
            <Text style={styles.numberVal}>{formatINRFull(data.winning_amount || 0)}</Text>
          </View>
          <View style={styles.numberCard}>
            <Text style={styles.numberLabel}>5% DEPOSIT</Text>
            <Text style={styles.numberVal}>{formatINRFull(data.deposit_amount || 0)}</Text>
          </View>
        </View>

        {/* Primary actions */}
        {!isTerminal && primaryActions.length > 0 && (
          <View style={styles.actionPanel}>
            <Text style={styles.sectionLabel}>NEXT OPERATOR ACTION</Text>
            <View style={{ gap: 8, marginTop: 6 }}>
              {primaryActions.map((a) => (
                <ActionButton
                  key={a.key} def={a} disabled={busy}
                  onPress={() => {
                    if (a.needsModal) setModal({ kind: a.key, def: a });
                    else transition(a.key);
                  }}
                />
              ))}
            </View>
          </View>
        )}

        {/* Override toolbar */}
        {!isTerminal && (
          <View style={styles.overrideRow}>
            <OverrideBtn label="Flag No-Show" icon={<Ban size={12} color={colors.red} />}
              onPress={() => setModal({ kind: 'flag_no_show', def: { key: 'flag_no_show', label: 'Flag No-Show', icon: Ban, tone: 'danger' } })} />
            <OverrideBtn label="Mark Delayed" icon={<Pause size={12} color={colors.warning} />}
              onPress={() => setModal({ kind: 'mark_delayed', def: { key: 'mark_delayed', label: 'Mark Delayed', icon: Pause, tone: 'warn' } })} />
            <OverrideBtn label="Mark Dispute" icon={<FileWarning size={12} color={colors.red} />}
              onPress={() => setModal({ kind: 'mark_dispute', def: { key: 'mark_dispute', label: 'Mark Dispute', icon: FileWarning, tone: 'danger' } })} />
          </View>
        )}

        {/* Vehicle + dealer summary */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>VEHICLE</Text>
          <View style={styles.kvCard}>
            <KV k="Reg." v={data.snapshot?.car_reg || '—'} />
            <KV k="Variant" v={data.snapshot?.car_variant || '—'} />
            <KV k="KMs" v={data.snapshot?.car_kms ? `${(data.snapshot.car_kms || 0).toLocaleString('en-IN')} km` : '—'} />
            <KV k="Auction" v={data.auction_id?.slice(0, 8).toUpperCase()} />
          </View>
        </View>

        {/* Deposit instructions / proof */}
        {data.deposit_instructions && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>DEPOSIT INSTRUCTIONS (BUYER-VISIBLE)</Text>
            <View style={styles.instructionsCard}>
              <Text style={styles.instructionsText}>{data.deposit_instructions}</Text>
              {data.deposit_deadline_at && (
                <Text style={styles.deadlineText}>DEADLINE · {new Date(data.deposit_deadline_at).toLocaleString()}</Text>
              )}
            </View>
          </View>
        )}

        {data.deposit_proof && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>DEPOSIT PROOF (BUYER UPLOAD)</Text>
            <View style={styles.proofCard}>
              <View style={styles.proofIcon}>
                <FileImage size={14} color={colors.silver} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.proofKind}>{(data.deposit_proof.kind || 'note').toUpperCase()}</Text>
                <Text style={styles.proofMeta}>
                  {data.deposit_proof.filename || '—'} · {data.deposit_proof.mime_type || ''}
                </Text>
                {data.deposit_proof.note && <Text style={styles.proofNote}>{data.deposit_proof.note}</Text>}
                <Text style={styles.proofTs}>UPLOADED · {fmtTs(data.deposit_proof.uploaded_at)}</Text>
              </View>
              {data.deposit_proof.content_base64 && (
                <TouchableOpacity
                  onPress={() => { /* future: open base64 viewer */ toast.show('Open in operator viewer', 'info'); }}
                  style={styles.proofViewBtn}
                >
                  <ChevronRight size={14} color={colors.silver} />
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Visit details */}
        {data.visit_address && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>VISIT DETAILS</Text>
            <View style={styles.kvCard}>
              <KV k="Address" v={data.visit_address} multiline />
              {data.visit_window_start && <KV k="Window start" v={fmtTs(data.visit_window_start)} />}
              {data.visit_window_end && <KV k="Window end" v={fmtTs(data.visit_window_end)} />}
              {data.visit_instructions_for_dealer && <KV k="Instructions" v={data.visit_instructions_for_dealer} multiline />}
            </View>
          </View>
        )}

        {/* Final payment */}
        {data.full_payment_amount && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>FINAL PAYMENT</Text>
            <View style={styles.kvCard}>
              <KV k="Amount" v={formatINRFull(data.full_payment_amount)} />
              {data.full_payment_method && <KV k="Method" v={data.full_payment_method} />}
              {data.full_payment_ref && <KV k="Reference" v={data.full_payment_ref} />}
              {data.full_payment_received_at && <KV k="Received at" v={fmtTs(data.full_payment_received_at)} />}
            </View>
          </View>
        )}

        {/* Refund */}
        {data.refund_amount && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>REFUND</Text>
            <View style={styles.kvCard}>
              <KV k="Amount" v={formatINRFull(data.refund_amount)} />
              {data.refund_method && <KV k="Method" v={data.refund_method} />}
              {data.refund_ref && <KV k="Reference" v={data.refund_ref} />}
              {data.refund_completed_at && <KV k="Completed at" v={fmtTs(data.refund_completed_at)} />}
            </View>
          </View>
        )}

        {/* Tabs: audit / notes / messages */}
        <View style={styles.tabRow}>
          <TabBtn active={tab === 'audit'} label={`AUDIT · ${(data.audit || []).length}`} onPress={() => setTab('audit')} />
          <TabBtn active={tab === 'notes'} label={`NOTES · ${(data.internal_notes || []).length}`} onPress={() => setTab('notes')} />
          <TabBtn active={tab === 'messages'} label={`MSGS · ${(data.dealer_messages || []).length}`} onPress={() => setTab('messages')} />
        </View>

        {tab === 'audit' && <AuditList items={data.audit || []} />}
        {tab === 'notes' && (
          <NotesPanel
            notes={data.internal_notes || []}
            onAdd={async (text) => {
              try { await api.adminSettlementInternalNote(id!, text); await load(); toast.show('Note saved', 'success'); }
              catch (e: any) { toast.show(e.message || 'Failed', 'error'); throw e; }
            }}
          />
        )}
        {tab === 'messages' && (
          <MessagesPanel
            messages={data.dealer_messages || []}
            onAdd={async (text) => {
              try { await api.adminSettlementDealerMessage(id!, text); await load(); toast.show('Message sent to buyer', 'success'); }
              catch (e: any) { toast.show(e.message || 'Failed', 'error'); throw e; }
            }}
          />
        )}
      </ScrollView>

      {/* Action modal */}
      {modal && (
        <ActionModal
          def={modal.def}
          state={data.state}
          deposit={data.deposit_amount}
          balanceDefault={Math.max(0, (data.winning_amount || 0) - (data.deposit_amount || 0))}
          visitAddressDefault={data.visit_address || 'Q Drives Mumbai office'}
          onClose={() => setModal(null)}
          onSubmit={(payload, reason) => transition(modal.kind, payload, reason)}
          busy={busy}
        />
      )}
    </View>
  );
}

/* ───────────── helpers + sub-views ───────────── */

function ActionButton({ def, onPress, disabled }: { def: ActionDef; onPress: () => void; disabled?: boolean }) {
  const Icon = def.icon;
  const tint = def.tone === 'success' ? colors.success
    : def.tone === 'danger' ? colors.red
    : def.tone === 'warn' ? colors.warning
    : colors.red;
  const bg = def.tone === 'primary' ? colors.red : tint + '14';
  const fg = def.tone === 'primary' ? '#fff' : tint;
  return (
    <TouchableOpacity
      disabled={disabled} onPress={onPress} activeOpacity={0.85}
      style={[styles.actionBtn, { backgroundColor: bg, borderColor: tint + '88' }, disabled && { opacity: 0.5 }]}
      testID={`act-${def.key}`}
    >
      <Icon size={14} color={fg} strokeWidth={2.4} />
      <Text style={[styles.actionBtnText, { color: fg }]}>{def.label}</Text>
      <ChevronRight size={14} color={fg} />
    </TouchableOpacity>
  );
}

function OverrideBtn({ label, icon, onPress }: { label: string; icon: any; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.overrideBtn} activeOpacity={0.8}>
      {icon}
      <Text style={styles.overrideBtnText}>{label}</Text>
    </TouchableOpacity>
  );
}

function KV({ k, v, multiline }: { k: string; v: string; multiline?: boolean }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvK}>{k}</Text>
      <Text style={[styles.kvV, multiline && { flexShrink: 1 }]} numberOfLines={multiline ? 4 : 1}>{v}</Text>
    </View>
  );
}

function TabBtn({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.tabBtn, active && styles.tabBtnActive]} activeOpacity={0.8}>
      <Text style={[styles.tabBtnText, active && styles.tabBtnTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function AuditList({ items }: { items: any[] }) {
  if (!items.length) return <View style={styles.emptyBox}><Text style={styles.emptyText}>No transitions yet.</Text></View>;
  return (
    <View style={{ gap: 8 }}>
      {items.slice().reverse().map((a, i) => (
        <View key={a.id || i} style={styles.auditCard}>
          <View style={styles.auditHead}>
            <Text style={styles.auditAction}>{(a.action || '').toUpperCase().replace(/_/g, ' ')}</Text>
            <Text style={styles.auditTs}>{fmtTs(a.ts)}</Text>
          </View>
          <View style={styles.auditFlow}>
            <Text style={styles.auditFromTo}>
              {(a.from_state || '∅').replace(/_/g, ' ')} <Text style={{ color: colors.red }}>→</Text> {(a.to_state || '').replace(/_/g, ' ')}
            </Text>
          </View>
          <Text style={styles.auditActor}>BY · {a.actor_id?.slice(0, 8).toUpperCase() || 'SYSTEM'}</Text>
          {a.meta?.reason && <Text style={styles.auditReason}>"{a.meta.reason}"</Text>}
        </View>
      ))}
    </View>
  );
}

function NotesPanel({ notes, onAdd }: { notes: any[]; onAdd: (t: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await onAdd(text.trim()); setText(''); } catch {} finally { setBusy(false); }
  };
  return (
    <View>
      <View style={styles.composerRow}>
        <TextInput
          value={text} onChangeText={setText} multiline
          placeholder="Internal note (operator-only)…"
          placeholderTextColor={colors.textMuted}
          style={styles.composer}
        />
        <TouchableOpacity onPress={submit} disabled={!text.trim() || busy} style={[styles.composerSend, (!text.trim() || busy) && { opacity: 0.4 }]}>
          <Send size={14} color={colors.red} />
        </TouchableOpacity>
      </View>
      {notes.length === 0 ? (
        <View style={styles.emptyBox}><Text style={styles.emptyText}>No internal notes yet.</Text></View>
      ) : (
        notes.slice().reverse().map((n: any, i: number) => (
          <View key={n.id || i} style={styles.noteCard}>
            <View style={styles.noteIcon}><StickyNote size={12} color={colors.textChrome} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.noteText}>{n.text}</Text>
              <Text style={styles.noteMeta}>{fmtTs(n.at)} · {n.by?.slice(0, 8).toUpperCase() || 'OP'}</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function MessagesPanel({ messages, onAdd }: { messages: any[]; onAdd: (t: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await onAdd(text.trim()); setText(''); } catch {} finally { setBusy(false); }
  };
  return (
    <View>
      <View style={styles.composerRow}>
        <TextInput
          value={text} onChangeText={setText} multiline
          placeholder="Message visible to buyer…"
          placeholderTextColor={colors.textMuted}
          style={styles.composer}
        />
        <TouchableOpacity onPress={submit} disabled={!text.trim() || busy} style={[styles.composerSend, (!text.trim() || busy) && { opacity: 0.4 }]}>
          <Send size={14} color={colors.success} />
        </TouchableOpacity>
      </View>
      {messages.length === 0 ? (
        <View style={styles.emptyBox}><Text style={styles.emptyText}>No buyer-visible messages yet.</Text></View>
      ) : (
        messages.slice().reverse().map((m: any, i: number) => (
          <View key={m.id || i} style={styles.msgCard}>
            <View style={[styles.noteIcon, { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' }]}>
              <MessageSquare size={12} color={colors.success} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.noteText}>{m.text}</Text>
              <Text style={styles.noteMeta}>{fmtTs(m.at)} · OPERATOR</Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

function ActionModal({
  def, state, deposit, balanceDefault, visitAddressDefault, onClose, onSubmit, busy,
}: {
  def: ActionDef; state: string; deposit: number; balanceDefault: number;
  visitAddressDefault: string;
  onClose: () => void;
  onSubmit: (payload: any, reason?: string) => Promise<void>;
  busy: boolean;
}) {
  // Per-action form fields
  const [reason, setReason] = useState('');
  const [instructions, setInstructions] = useState('');
  const [deadlineHours, setDeadlineHours] = useState('48');
  const [address, setAddress] = useState(visitAddressDefault);
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [amount, setAmount] = useState(String(balanceDefault || ''));
  const [refundAmount, setRefundAmount] = useState(String(deposit || ''));
  const [method, setMethod] = useState('NEFT');
  const [refCode, setRefCode] = useState('');

  const submit = async () => {
    let payload: any = {};
    if (def.key === 'request_deposit') payload = { deadline_hours: Number(deadlineHours) || 48, instructions };
    else if (def.key === 'schedule_visit') payload = { address, window_start: windowStart || null, window_end: windowEnd || null, instructions };
    else if (def.key === 'request_full_payment') payload = { amount: Number(amount) || 0, instructions };
    else if (def.key === 'mark_full_payment_received') payload = { method, ref: refCode };
    else if (def.key === 'approve_refund') payload = { amount: Number(refundAmount) || deposit };
    else if (def.key === 'mark_refund_completed') payload = { method, ref: refCode };
    await onSubmit(payload, reason || undefined);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{def.label}</Text>
              <TouchableOpacity onPress={onClose} style={styles.sheetClose}><X size={16} color={colors.textChrome} /></TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 32 }}>
              {def.key === 'request_deposit' && (
                <>
                  <Field label="Deadline (hours)">
                    <TextInput value={deadlineHours} onChangeText={setDeadlineHours} keyboardType="numeric" style={styles.input} />
                  </Field>
                  <Field label="Instructions for buyer (visible)">
                    <TextInput multiline value={instructions} onChangeText={setInstructions} style={[styles.input, { minHeight: 80 }]} placeholder="Pay 5% to QD-CURRENT-AC ..." placeholderTextColor={colors.textMuted} />
                  </Field>
                </>
              )}
              {def.key === 'schedule_visit' && (
                <>
                  <Field label="Visit address">
                    <TextInput multiline value={address} onChangeText={setAddress} style={[styles.input, { minHeight: 60 }]} />
                  </Field>
                  <Field label="Window start (ISO)">
                    <TextInput value={windowStart} onChangeText={setWindowStart} placeholder="2025-06-15T10:00" placeholderTextColor={colors.textMuted} style={styles.input} />
                  </Field>
                  <Field label="Window end (ISO)">
                    <TextInput value={windowEnd} onChangeText={setWindowEnd} placeholder="2025-06-15T18:00" placeholderTextColor={colors.textMuted} style={styles.input} />
                  </Field>
                  <Field label="Instructions for buyer">
                    <TextInput multiline value={instructions} onChangeText={setInstructions} placeholder="Bring originals, photo ID..." placeholderTextColor={colors.textMuted} style={[styles.input, { minHeight: 60 }]} />
                  </Field>
                </>
              )}
              {def.key === 'request_full_payment' && (
                <>
                  <Field label="Balance amount (₹)">
                    <TextInput value={amount} onChangeText={setAmount} keyboardType="numeric" style={styles.input} />
                  </Field>
                  <Field label="Instructions for buyer">
                    <TextInput multiline value={instructions} onChangeText={setInstructions} placeholder="Pay balance to QD account ..." placeholderTextColor={colors.textMuted} style={[styles.input, { minHeight: 80 }]} />
                  </Field>
                </>
              )}
              {(def.key === 'mark_full_payment_received' || def.key === 'mark_refund_completed') && (
                <>
                  <Field label="Method">
                    <TextInput value={method} onChangeText={setMethod} placeholder="NEFT / IMPS / RTGS" placeholderTextColor={colors.textMuted} style={styles.input} />
                  </Field>
                  <Field label="Reference / UTR">
                    <TextInput value={refCode} onChangeText={setRefCode} placeholder="UTR1234..." placeholderTextColor={colors.textMuted} style={styles.input} />
                  </Field>
                </>
              )}
              {def.key === 'approve_refund' && (
                <Field label="Refund amount (₹)">
                  <TextInput value={refundAmount} onChangeText={setRefundAmount} keyboardType="numeric" style={styles.input} />
                </Field>
              )}
              <Field label="Operator note (audit reason)">
                <TextInput multiline value={reason} onChangeText={setReason} placeholder="Why this action?" placeholderTextColor={colors.textMuted} style={[styles.input, { minHeight: 60 }]} />
              </Field>
              <TouchableOpacity disabled={busy} onPress={submit} style={[styles.modalSubmit, busy && { opacity: 0.5 }]} testID="modal-submit">
                <Text style={styles.modalSubmitText}>CONFIRM · {def.label.toUpperCase()}</Text>
              </TouchableOpacity>
            </ScrollView>
          </KeyboardAvoidingView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Field({ label, children }: any) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function fmtTs(ts?: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  } catch { return '—'; }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loaderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 50, paddingBottom: 14, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bgElevated },
  backBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kicker: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', marginTop: 2, letterSpacing: -0.4 },

  stateStrip: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: radii.md, borderWidth: 1.5, backgroundColor: colors.bgCard, marginBottom: 14, alignItems: 'flex-start' },
  stateDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  stateLabel: { fontSize: 13, fontWeight: '900', letterSpacing: 1.2 },
  stateSub: { color: colors.textChrome, fontSize: 12, fontWeight: '600', marginTop: 4, lineHeight: 17 },
  priorState: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2, marginTop: 6, fontVariant: ['tabular-nums'] },

  numbersRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  numberCard: { flex: 1, padding: 14, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: 'rgba(185,28,28,0.25)' },
  numberLabel: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  numberVal: { color: colors.textPrimary, fontSize: 19, fontWeight: '900', marginTop: 4, fontVariant: ['tabular-nums'], letterSpacing: -0.5 },

  actionPanel: { padding: 14, borderRadius: radii.md, backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border, marginBottom: 14 },
  sectionLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },

  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 13, borderRadius: 999, borderWidth: 1 },
  actionBtnText: { flex: 1, fontSize: 13, fontWeight: '900', letterSpacing: 0.4 },

  overrideRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  overrideBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  overrideBtnText: { color: colors.textChrome, fontSize: 10.5, fontWeight: '900', letterSpacing: 0.4 },

  section: { marginBottom: 14 },
  kvCard: { padding: 12, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginTop: 6, gap: 8 },
  kvRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  kvK: { color: colors.textMuted, fontSize: 10.5, fontWeight: '900', letterSpacing: 0.8, width: 90 },
  kvV: { color: colors.textPrimary, fontSize: 12, fontWeight: '600', flex: 1, fontVariant: ['tabular-nums'] },

  instructionsCard: { padding: 12, borderRadius: 10, backgroundColor: 'rgba(245,158,11,0.06)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.30)', marginTop: 6 },
  instructionsText: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '500', lineHeight: 17 },
  deadlineText: { color: colors.warning, fontSize: 10, fontWeight: '900', letterSpacing: 1, marginTop: 8, fontVariant: ['tabular-nums'] },

  proofCard: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginTop: 6, alignItems: 'flex-start' },
  proofIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  proofKind: { color: colors.silver, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  proofMeta: { color: colors.textChrome, fontSize: 11, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  proofNote: { color: colors.textPrimary, fontSize: 12, fontWeight: '500', marginTop: 4 },
  proofTs: { color: colors.textMuted, fontSize: 9.5, fontWeight: '800', marginTop: 6, letterSpacing: 0.6, fontVariant: ['tabular-nums'] },
  proofViewBtn: { width: 28, height: 28, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },

  tabRow: { flexDirection: 'row', gap: 6, marginTop: 4, marginBottom: 10 },
  tabBtn: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  tabBtnActive: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: colors.red },
  tabBtnText: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  tabBtnTextActive: { color: colors.red },

  emptyBox: { padding: 16, borderRadius: 10, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyText: { color: colors.textMuted, fontSize: 11.5, fontWeight: '700', textAlign: 'center' },

  auditCard: { padding: 11, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  auditHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  auditAction: { color: colors.textPrimary, fontSize: 12, fontWeight: '900', letterSpacing: 0.6 },
  auditTs: { color: colors.textMuted, fontSize: 10, fontWeight: '800', fontVariant: ['tabular-nums'] },
  auditFlow: { marginTop: 4 },
  auditFromTo: { color: colors.textChrome, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  auditActor: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1, marginTop: 6, fontVariant: ['tabular-nums'] },
  auditReason: { color: colors.textChrome, fontSize: 11, fontStyle: 'italic', marginTop: 6 },

  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginBottom: 10 },
  composer: { flex: 1, color: colors.textPrimary, fontSize: 12.5, fontWeight: '500', minHeight: 44, padding: 10, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: 10, textAlignVertical: 'top' },
  composerSend: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(185,28,28,0.10)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.45)' },

  noteCard: { flexDirection: 'row', gap: 9, padding: 10, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginBottom: 7 },
  noteIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  noteText: { color: colors.textPrimary, fontSize: 12, fontWeight: '600', lineHeight: 16 },
  noteMeta: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 4, fontVariant: ['tabular-nums'] },
  msgCard: { flexDirection: 'row', gap: 9, padding: 10, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: 'rgba(16,185,129,0.25)', marginBottom: 7 },

  /* Modal */
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bgElevated, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1.5, borderColor: 'rgba(185,28,28,0.4)', maxHeight: '90%' },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginVertical: 8 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  sheetTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', letterSpacing: -0.3 },
  sheetClose: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },

  fieldLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2, marginBottom: 6 },
  input: { backgroundColor: colors.bgCard, color: colors.textPrimary, fontSize: 13, padding: 11, borderRadius: 10, borderWidth: 1, borderColor: colors.border, fontWeight: '500', textAlignVertical: 'top' },

  modalSubmit: { backgroundColor: colors.red, paddingVertical: 14, borderRadius: 999, alignItems: 'center', marginTop: 8 },
  modalSubmitText: { color: '#fff', fontSize: 12.5, fontWeight: '900', letterSpacing: 1 },
});
