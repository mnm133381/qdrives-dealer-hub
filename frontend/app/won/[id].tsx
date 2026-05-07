/**
 * Dealer Won Settlement Screen — read-only status timeline + structured
 * next-action UI for the dealer.
 *
 * Q Drives is sole seller. Operators control every state transition. The
 * dealer's only direct write is uploading deposit proof
 * (mark_payment_sent). Everything else is operator-driven.
 *
 * Sections:
 *   • Hero state strip — current state, next-required-action, kicker.
 *   • Vehicle + commercial summary (winning bid, 5% deposit).
 *   • Action panel — only renders the dealer's actionable item for this
 *     state. For non-actionable states, shows a calm "what happens next"
 *     read-only card.
 *   • Visit details (when scheduled).
 *   • Operator messages timeline (dealer-visible, append-only).
 *   • Public audit trail (state transitions only — no operator metadata).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Modal, Pressable, KeyboardAvoidingView, Platform, RefreshControl,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Banknote, Upload, ShieldCheck, MapPin, Wallet, RotateCcw,
  CheckCircle2, AlertOctagon, FileImage, Clock, ChevronRight, X, MessageSquare,
  Pause, Trophy,
} from 'lucide-react-native';
import { colors, radii, formatINR, formatINRFull } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';

const STATE_DEALER: Record<string, { label: string; tint: string; sub: string; next?: string }> = {
  auction_won:                  { label: 'AUCTION WON',                tint: colors.silver,  sub: 'Your win is being intaked by the operator team.', next: 'Operator will request the 5% refundable deposit shortly.' },
  awaiting_operator_review:     { label: 'AWAITING OPERATOR REVIEW',   tint: colors.silver,  sub: 'Operator team is reviewing your win.', next: 'You will receive deposit instructions soon.' },
  deposit_requested:            { label: 'DEPOSIT REQUESTED',          tint: colors.warning, sub: 'Pay the 5% refundable deposit and upload proof.', next: 'After upload, operator will verify your proof.' },
  deposit_under_verification:   { label: 'DEPOSIT UNDER VERIFICATION', tint: colors.warning, sub: 'Operator is verifying the deposit you submitted.', next: 'You will be notified once verification is complete.' },
  deposit_verified:             { label: 'DEPOSIT VERIFIED',           tint: colors.success, sub: 'Deposit cleared. Operator is scheduling your visit.', next: 'You will receive visit details (address + window) shortly.' },
  visit_scheduled:              { label: 'VISIT SCHEDULED',            tint: colors.info,    sub: 'Visit the Q Drives office in your scheduled window.', next: 'Bring originals & photo ID. Inspection will happen on-site.' },
  inspection_completed:         { label: 'INSPECTION COMPLETED',       tint: colors.info,    sub: 'Physical inspection is complete.', next: 'Operator will request final payment OR initiate refund of your deposit.' },
  refund_approved:              { label: 'REFUND APPROVED',            tint: colors.warning, sub: 'Your deposit refund has been approved.', next: 'Operator is processing the refund. You will be notified once done.' },
  refund_completed:             { label: 'REFUND COMPLETED',           tint: colors.silver,  sub: 'Your refund has been processed.', next: 'Audit trail is locked. No further action required.' },
  full_payment_requested:       { label: 'FINAL PAYMENT REQUESTED',    tint: colors.warning, sub: 'Pay the remaining balance to confirm purchase.', next: 'Once received, operator will mark vehicle as delivered.' },
  full_payment_received:        { label: 'FINAL PAYMENT RECEIVED',     tint: colors.success, sub: 'Final payment confirmed.', next: 'Operator is preparing vehicle handover.' },
  vehicle_delivered:            { label: 'VEHICLE DELIVERED',          tint: colors.success, sub: 'Vehicle has been handed over.', next: 'Operator will close the deal shortly.' },
  completed:                    { label: 'DEAL COMPLETE',              tint: colors.success, sub: 'Settlement closed. Audit trail is final.', next: 'No further action required.' },
  no_show_review:               { label: 'NO-SHOW REVIEW',             tint: colors.red,     sub: 'A no-show has been flagged on your settlement.', next: 'Please contact operations to discuss next steps.' },
  settlement_delayed:           { label: 'SETTLEMENT DELAYED',         tint: colors.red,     sub: 'Operator has flagged this settlement as delayed.', next: 'Please check messages for operator instructions.' },
  dispute:                      { label: 'DISPUTE OPEN',               tint: colors.red,     sub: 'A dispute has been opened on this settlement.', next: 'See the disputes section in your profile.' },
};

export default function DealerWonScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showProof, setShowProof] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.settlementMine(id);
      setData(r);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load', 'error');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading || !data) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
        <View style={styles.loaderWrap}><ActivityIndicator color={colors.red} /></View>
      </View>
    );
  }

  const meta = STATE_DEALER[data.state] || { label: data.state, tint: colors.silver, sub: '', next: '' };
  const isTerminal = data.state === 'completed' || data.state === 'refund_completed';

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} testID="won-back">
          <ArrowLeft size={18} color={colors.textChrome} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>YOUR DEAL · {data.id?.slice(0, 8).toUpperCase()}</Text>
          <Text style={styles.title} numberOfLines={1}>
            {data.snapshot?.car_year} {data.snapshot?.car_make} {data.snapshot?.car_model}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {/* Hero state strip */}
        <View style={[styles.hero, { borderColor: meta.tint + '88' }]}>
          <View style={styles.heroHead}>
            <View style={[styles.heroDot, { backgroundColor: meta.tint }]} />
            <Text style={[styles.heroLabel, { color: meta.tint }]}>{meta.label}</Text>
          </View>
          <Text style={styles.heroSub}>{meta.sub}</Text>
          {meta.next && (
            <View style={styles.heroNextRow}>
              <Clock size={11} color={colors.textMuted} />
              <Text style={styles.heroNext}>NEXT · {meta.next}</Text>
            </View>
          )}
        </View>

        {/* Numbers */}
        <View style={styles.numbersRow}>
          <View style={styles.numberCard}>
            <Text style={styles.numberLabel}>WINNING BID</Text>
            <Text style={styles.numberVal}>{formatINRFull(data.winning_amount || 0)}</Text>
          </View>
          <View style={styles.numberCard}>
            <Text style={styles.numberLabel}>5% REFUNDABLE DEPOSIT</Text>
            <Text style={styles.numberVal}>{formatINRFull(data.deposit_amount || 0)}</Text>
          </View>
        </View>

        {/* Action panel */}
        {data.state === 'deposit_requested' && (
          <DealerActionDeposit
            settlement={data}
            onUploaded={async () => { await load(); toast.show('Proof submitted to operator', 'success'); }}
          />
        )}

        {data.state === 'deposit_under_verification' && (
          <View style={styles.passiveCard}>
            <ShieldCheck size={18} color={colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.passiveTitle}>Operator is verifying your proof</Text>
              <Text style={styles.passiveBody}>
                You will receive a notification once verification is complete. If the operator rejects the proof, you'll be asked to upload a fresh one.
              </Text>
              <TouchableOpacity onPress={() => setShowProof(true)} style={styles.linkBtn}>
                <FileImage size={11} color={colors.silver} />
                <Text style={styles.linkBtnText}>VIEW MY UPLOADED PROOF</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {(data.state === 'visit_scheduled') && (
          <View style={styles.visitCard}>
            <View style={styles.visitHead}>
              <MapPin size={14} color={colors.info} />
              <Text style={styles.visitTitle}>VISIT INSTRUCTIONS</Text>
            </View>
            <KV k="Address" v={data.visit_address || 'Q Drives Mumbai office'} multiline />
            {data.visit_window_start && <KV k="From" v={fmtTs(data.visit_window_start)} />}
            {data.visit_window_end && <KV k="Until" v={fmtTs(data.visit_window_end)} />}
            {data.visit_instructions_for_dealer && (
              <KV k="Notes" v={data.visit_instructions_for_dealer} multiline />
            )}
            <Text style={styles.visitFoot}>
              The vehicle will be physically available for inspection. Bring photo ID and original payment proof.
            </Text>
          </View>
        )}

        {data.state === 'full_payment_requested' && (
          <View style={styles.actionPanel}>
            <Text style={styles.actionTitle}>Pay the remaining balance</Text>
            <View style={styles.balanceRow}>
              <Text style={styles.balanceLabel}>BALANCE</Text>
              <Text style={styles.balanceVal}>
                {formatINRFull(data.full_payment_amount || (data.winning_amount - data.deposit_amount))}
              </Text>
            </View>
            {(data as any).full_payment_instructions && (
              <View style={styles.instructionsCard}>
                <Text style={styles.instructionsText}>{(data as any).full_payment_instructions}</Text>
              </View>
            )}
            <Text style={styles.actionNote}>
              Pay via NEFT / IMPS / RTGS to the Q Drives current account, then notify the operator with your UTR. Operator will mark "received" once verified.
            </Text>
          </View>
        )}

        {data.state === 'refund_approved' && (
          <View style={styles.passiveCard}>
            <RotateCcw size={18} color={colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.passiveTitle}>Refund approved</Text>
              <Text style={styles.passiveBody}>
                Operator is processing your deposit refund. You will be notified once it's transferred. The amount approved is{' '}
                <Text style={{ color: colors.warning, fontWeight: '900' }}>{formatINRFull(data.refund_amount || data.deposit_amount)}</Text>.
              </Text>
            </View>
          </View>
        )}

        {data.state === 'refund_completed' && (
          <View style={styles.terminalCard}>
            <RotateCcw size={20} color={colors.silver} />
            <View style={{ flex: 1 }}>
              <Text style={styles.terminalTitle}>Refund completed</Text>
              <Text style={styles.terminalBody}>
                Refund of {formatINRFull(data.refund_amount || data.deposit_amount)} processed
                {data.refund_method && ` via ${data.refund_method}`}
                {data.refund_ref && ` (ref: ${data.refund_ref})`}.
              </Text>
            </View>
          </View>
        )}

        {data.state === 'completed' && (
          <View style={[styles.terminalCard, { borderColor: 'rgba(16,185,129,0.4)', backgroundColor: 'rgba(16,185,129,0.06)' }]}>
            <Trophy size={20} color={colors.success} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.terminalTitle, { color: colors.success }]}>Deal complete</Text>
              <Text style={styles.terminalBody}>
                Vehicle delivered. Settlement closed. The audit trail below is permanent and read-only.
              </Text>
            </View>
          </View>
        )}

        {(['settlement_delayed', 'no_show_review', 'dispute'].includes(data.state)) && (
          <View style={[styles.passiveCard, { borderColor: 'rgba(220,38,38,0.4)' }]}>
            <AlertOctagon size={18} color={colors.red} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.passiveTitle, { color: colors.red }]}>{meta.label}</Text>
              <Text style={styles.passiveBody}>{meta.sub}</Text>
              <Text style={styles.passiveBody}>{meta.next}</Text>
            </View>
          </View>
        )}

        {/* Operator messages */}
        {(data.dealer_messages || []).length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>OPERATOR MESSAGES</Text>
            {(data.dealer_messages || []).slice().reverse().map((m: any, i: number) => (
              <View key={m.id || i} style={styles.msgCard}>
                <View style={styles.msgIcon}><MessageSquare size={11} color={colors.success} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.msgText}>{m.text}</Text>
                  <Text style={styles.msgMeta}>{fmtTs(m.at)} · OPERATOR</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* Public audit trail */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SETTLEMENT TIMELINE</Text>
          {(data.audit_public || []).slice().reverse().map((a: any, i: number) => (
            <View key={a.id || i} style={styles.auditCard}>
              <View style={styles.auditDot} />
              <View style={{ flex: 1 }}>
                <Text style={styles.auditAction}>{(a.action || '').toUpperCase().replace(/_/g, ' ')}</Text>
                <Text style={styles.auditFromTo}>
                  {(a.from_state || '∅').replace(/_/g, ' ')} → {(a.to_state || '').replace(/_/g, ' ')}
                </Text>
                <Text style={styles.auditTs}>{fmtTs(a.ts)}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {showProof && (
        <ProofPreviewModal settlementId={data.id} onClose={() => setShowProof(false)} />
      )}
    </View>
  );
}

/* ───────────── Sub-views ───────────── */

function DealerActionDeposit({ settlement, onUploaded }: { settlement: any; onUploaded: () => Promise<void> }) {
  const toast = useToast();
  const [kind, setKind] = useState<'utr' | 'image' | 'note'>('utr');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!note.trim() && kind !== 'image') {
      toast.show('Add at least a UTR/reference or note', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.settlementMarkPaymentSent(settlement.id, {
        kind, note: note.trim() || undefined,
      });
      await onUploaded();
      setNote('');
    } catch (e: any) {
      toast.show(e.message || 'Failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.actionPanel}>
      <Text style={styles.actionTitle}>Pay the 5% refundable deposit</Text>
      <View style={styles.balanceRow}>
        <Text style={styles.balanceLabel}>AMOUNT DUE</Text>
        <Text style={styles.balanceVal}>{formatINRFull(settlement.deposit_amount)}</Text>
      </View>

      {(settlement as any).deposit_instructions && (
        <View style={styles.instructionsCard}>
          <Text style={styles.instructionsText}>{(settlement as any).deposit_instructions}</Text>
        </View>
      )}

      {settlement.deposit_deadline_at && (
        <Text style={styles.deadlineText}>DEADLINE · {fmtTs(settlement.deposit_deadline_at)}</Text>
      )}

      <View style={styles.kindRow}>
        {(['utr', 'image', 'note'] as const).map((k) => (
          <TouchableOpacity key={k} onPress={() => setKind(k)} style={[styles.kindChip, kind === k && styles.kindChipActive]}>
            <Text style={[styles.kindChipText, kind === k && styles.kindChipTextActive]}>{k.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <TextInput
        value={note} onChangeText={setNote} multiline
        placeholder={kind === 'utr' ? 'Enter UTR / transaction reference' : kind === 'image' ? '(optional) Add a note about the upload' : 'Note for the operator'}
        placeholderTextColor={colors.textMuted}
        style={[styles.input, { minHeight: 64 }]}
      />

      <TouchableOpacity onPress={submit} disabled={busy} style={[styles.primaryBtn, busy && { opacity: 0.5 }]} testID="dealer-mark-payment-sent">
        <Upload size={14} color="#fff" />
        <Text style={styles.primaryBtnText}>NOTIFY OPERATOR · PAYMENT SENT</Text>
      </TouchableOpacity>

      <Text style={styles.actionNote}>
        Operator will manually verify your proof. Verification typically completes within working hours.
      </Text>
    </View>
  );
}

function ProofPreviewModal({ settlementId, onClose }: { settlementId: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [proof, setProof] = useState<any | null>(null);
  useEffect(() => {
    api.settlementMyProof(settlementId).then((p) => setProof(p)).catch(() => setProof(null)).finally(() => setLoading(false));
  }, [settlementId]);
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Your uploaded proof</Text>
            <TouchableOpacity onPress={onClose} style={styles.sheetClose}><X size={16} color={colors.textChrome} /></TouchableOpacity>
          </View>
          <View style={{ padding: 18 }}>
            {loading ? <ActivityIndicator color={colors.red} /> : !proof ? (
              <Text style={styles.dimText}>No proof on file.</Text>
            ) : (
              <>
                <KV k="Kind" v={(proof.kind || 'note').toUpperCase()} />
                {proof.filename && <KV k="Filename" v={proof.filename} />}
                {proof.mime_type && <KV k="Type" v={proof.mime_type} />}
                {proof.note && <KV k="Note" v={proof.note} multiline />}
              </>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
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

function fmtTs(ts?: string | null): string {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch { return '—'; }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loaderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.bgElevated },
  backBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kicker: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '900', marginTop: 2, letterSpacing: -0.4 },

  hero: { padding: 14, borderRadius: radii.md, borderWidth: 1.5, backgroundColor: colors.bgCard, marginBottom: 14 },
  heroHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  heroDot: { width: 9, height: 9, borderRadius: 5 },
  heroLabel: { fontSize: 12.5, fontWeight: '900', letterSpacing: 1.2 },
  heroSub: { color: colors.textPrimary, fontSize: 13.5, fontWeight: '600', lineHeight: 19 },
  heroNextRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: colors.border },
  heroNext: { color: colors.textChrome, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, flex: 1 },

  numbersRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  numberCard: { flex: 1, padding: 13, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: 'rgba(185,28,28,0.25)' },
  numberLabel: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  numberVal: { color: colors.textPrimary, fontSize: 18, fontWeight: '900', marginTop: 4, fontVariant: ['tabular-nums'], letterSpacing: -0.5 },

  actionPanel: { padding: 14, borderRadius: radii.md, backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: 'rgba(245,158,11,0.40)', marginBottom: 14 },
  actionTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '900', letterSpacing: -0.2 },
  actionNote: { color: colors.textMuted, fontSize: 11, fontWeight: '600', marginTop: 10, lineHeight: 16 },

  balanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderRadius: 10, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, marginTop: 10 },
  balanceLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  balanceVal: { color: colors.warning, fontSize: 16, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: -0.4 },

  instructionsCard: { padding: 11, borderRadius: 10, backgroundColor: 'rgba(245,158,11,0.06)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.30)', marginTop: 10 },
  instructionsText: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '500', lineHeight: 17 },
  deadlineText: { color: colors.warning, fontSize: 10.5, fontWeight: '900', letterSpacing: 1, marginTop: 8, fontVariant: ['tabular-nums'] },

  kindRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  kindChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kindChipActive: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: colors.warning },
  kindChipText: { color: colors.textChrome, fontSize: 9.5, fontWeight: '900', letterSpacing: 0.6 },
  kindChipTextActive: { color: colors.warning },

  input: { backgroundColor: colors.bgCard, color: colors.textPrimary, fontSize: 13, padding: 11, borderRadius: 10, borderWidth: 1, borderColor: colors.border, fontWeight: '500', marginTop: 8, textAlignVertical: 'top' },

  primaryBtn: { flexDirection: 'row', gap: 8, backgroundColor: colors.red, paddingVertical: 13, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  primaryBtnText: { color: '#fff', fontSize: 12.5, fontWeight: '900', letterSpacing: 1 },

  passiveCard: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: radii.md, backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border, marginBottom: 14, alignItems: 'flex-start' },
  passiveTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900' },
  passiveBody: { color: colors.textChrome, fontSize: 12.5, fontWeight: '500', marginTop: 4, lineHeight: 17 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  linkBtnText: { color: colors.silver, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },

  visitCard: { padding: 14, borderRadius: radii.md, backgroundColor: 'rgba(59,130,246,0.06)', borderWidth: 1, borderColor: 'rgba(59,130,246,0.40)', marginBottom: 14, gap: 8 },
  visitHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  visitTitle: { color: colors.info, fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  visitFoot: { color: colors.textMuted, fontSize: 11, fontWeight: '600', marginTop: 8, lineHeight: 16 },

  terminalCard: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgElevated, marginBottom: 14, alignItems: 'flex-start' },
  terminalTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900' },
  terminalBody: { color: colors.textChrome, fontSize: 12.5, fontWeight: '500', marginTop: 4, lineHeight: 17 },

  section: { marginBottom: 14 },
  sectionLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4, marginBottom: 8 },

  kvRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  kvK: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 0.8, width: 70 },
  kvV: { color: colors.textPrimary, fontSize: 12, fontWeight: '600', flex: 1, fontVariant: ['tabular-nums'] },

  msgCard: { flexDirection: 'row', gap: 9, padding: 10, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: 'rgba(16,185,129,0.25)', marginBottom: 7 },
  msgIcon: { width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(16,185,129,0.10)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.4)' },
  msgText: { color: colors.textPrimary, fontSize: 12, fontWeight: '600', lineHeight: 16 },
  msgMeta: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 4, fontVariant: ['tabular-nums'] },

  auditCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 9, borderRadius: 10, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, marginBottom: 6 },
  auditDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6, backgroundColor: colors.success },
  auditAction: { color: colors.textPrimary, fontSize: 11.5, fontWeight: '900', letterSpacing: 0.4 },
  auditFromTo: { color: colors.textChrome, fontSize: 10.5, fontWeight: '700', marginTop: 2, letterSpacing: 0.4 },
  auditTs: { color: colors.textMuted, fontSize: 10, fontWeight: '800', marginTop: 4, fontVariant: ['tabular-nums'] },

  /* Sheet */
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bgElevated, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1.5, borderColor: 'rgba(185,28,28,0.4)', maxHeight: '70%' },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginVertical: 8 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  sheetTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '900', letterSpacing: -0.3 },
  sheetClose: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  dimText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
});
