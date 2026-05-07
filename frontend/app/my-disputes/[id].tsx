/**
 * Dealer Dispute Detail — read-mostly operator decision log.
 *
 * What the dealer sees:
 *   • Status (with NEXT-STEP copy so they know what to do).
 *   • Linked auction reference.
 *   • Immutable timeline (state transitions + operator actions).
 *   • Evidence list + ability to add evidence (note or file via base64).
 *   • Operator decision log (final outcome + reason if resolved).
 *   • SLA aging.
 *   • Withdraw button only if state="raised".
 *
 * What the dealer does NOT see:
 *   • Other party's evidence content (only existence).
 *   • Internal operator audit metadata (only public state log).
 *   • Counter-party reputation.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, FileText, MessageCircle, X, Hash, Clock, Flame, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react-native';
import { colors } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';

const SEVERITY_COLOR: Record<string, string> = {
  ok: '#10B981', warning: '#FBBF24', breach: '#F59E0B',
  critical: '#DC2626', closed: '#6B7280',
};

const STATE_LABEL: Record<string, string> = {
  raised: 'AWAITING REVIEW',
  under_review: 'UNDER REVIEW',
  evidence_pending: 'EVIDENCE NEEDED',
  decided: 'DECIDED',
  resolved: 'RESOLVED',
  withdrawn: 'WITHDRAWN',
};

const NEXT_STEP: Record<string, string> = {
  raised: 'An operator will review your case shortly. You can still add evidence or messages.',
  under_review: 'An operator is reviewing. Add any supporting evidence below.',
  evidence_pending: 'Operator has requested specific information. Please attach it via the Add Evidence button.',
  decided: 'Operator has decided. The outcome will be applied to both parties shortly.',
  resolved: 'This dispute is closed. The operator outcome above is final.',
  withdrawn: 'This dispute was withdrawn. No further action.',
};

const OUTCOME_TXT: Record<string, { label: string; color: string; icon: any }> = {
  decided_for_raiser: { label: 'DECIDED IN YOUR FAVOUR', color: '#10B981', icon: CheckCircle2 },
  decided_against_raiser: { label: 'DECIDED AGAINST', color: colors.red, icon: XCircle },
  decided_inconclusive: { label: 'INCONCLUSIVE', color: '#FBBF24', icon: AlertTriangle },
  frivolous: { label: 'MARKED FRIVOLOUS', color: '#7C3AED', icon: AlertTriangle },
  withdrawn: { label: 'WITHDRAWN', color: '#6B7280', icon: XCircle },
};

export default function DealerDisputeDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const did = String(id || '');
  const toast = useToast();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [evOpen, setEvOpen] = useState(false);
  const [msgText, setMsgText] = useState('');
  const [evNote, setEvNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getDispute(did);
      setData(r);
    } catch (e: any) { toast.show(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [did, toast]);

  useEffect(() => { load(); }, [load]);

  const sendMsg = async () => {
    if (msgText.trim().length === 0) return;
    setBusy(true);
    try {
      await api.postDisputeMessage(did, msgText.trim());
      setMsgText('');
      await load();
    } catch (e: any) { toast.show(e.message || 'Send failed', 'error'); }
    finally { setBusy(false); }
  };

  const addEvidence = async () => {
    if (evNote.trim().length === 0) { toast.show('Add a note or file', 'error'); return; }
    setBusy(true);
    try {
      await api.postDisputeEvidence(did, { kind: 'note', note: evNote.trim() });
      setEvNote('');
      setEvOpen(false);
      toast.show('Evidence added', 'success');
      await load();
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };

  const withdraw = async () => {
    setBusy(true);
    try {
      await api.withdrawDispute(did, 'withdrawn by raiser');
      toast.show('Dispute withdrawn', 'success');
      await load();
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };

  if (loading || !data) {
    return <View style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}><ActivityIndicator color={colors.red} /></View>;
  }

  const sev = data.aging?.severity || 'ok';
  const sevColor = SEVERITY_COLOR[sev];
  const isTerminal = data.is_terminal;
  const outcomeMeta = data.decision_outcome ? OUTCOME_TXT[data.decision_outcome] : null;
  const OutcomeIcon = outcomeMeta?.icon;

  return (
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <ChevronLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={s.headerType}>{data.type_label}</Text>
          <Text style={s.headerTitle} numberOfLines={2}>{data.title}</Text>
        </View>
        <View style={[s.statePill, { borderColor: sevColor }]}>
          <Text style={[s.statePillTxt, { color: sevColor }]}>{STATE_LABEL[data.state] || data.state.toUpperCase()}</Text>
        </View>
      </View>

      <ScrollView refreshControl={<RefreshControl refreshing={refreshing}
        onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
        tintColor={colors.red} />}>

        {/* What happens next — always visible, plain language */}
        <View style={[s.nextStepBox, { borderLeftColor: sevColor }]}>
          <Text style={s.nextStepLbl}>WHAT HAPPENS NEXT</Text>
          <Text style={s.nextStepTxt}>{NEXT_STEP[data.state] || ''}</Text>
        </View>

        {/* Outcome — only when resolved */}
        {outcomeMeta && (
          <View style={[s.outcomeBox, { borderColor: outcomeMeta.color, backgroundColor: outcomeMeta.color + '11' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {OutcomeIcon && <OutcomeIcon size={18} color={outcomeMeta.color} />}
              <Text style={[s.outcomeLbl, { color: outcomeMeta.color }]}>{outcomeMeta.label}</Text>
            </View>
            {data.decision_reason && (
              <Text style={s.outcomeReason}>{data.decision_reason}</Text>
            )}
            <Text style={s.outcomeTs}>Decided {data.decided_at ? new Date(data.decided_at).toLocaleString() : ''}</Text>
          </View>
        )}

        {/* SLA + auction reference — dense row */}
        <View style={s.metaRow}>
          <Meta label="AGING" value={`${(data.aging?.elapsed_hours || 0).toFixed(1)}H`} accent={sevColor} />
          <Meta label="SLA" value={`${data.sla_resolve_hours}H`} />
          {data.is_escalated && <Meta label="ESC" value="↑" accent={colors.red} />}
          {data.auction_id && <Meta label="LOT" value={data.auction_id.slice(0, 6)} />}
        </View>

        {/* Original description */}
        <View style={s.section}>
          <Text style={s.sectionLbl}>YOUR FILING</Text>
          <Text style={s.descTxt}>{data.description}</Text>
          <Text style={s.tsTxt}>Filed {new Date(data.raised_at).toLocaleString()}</Text>
        </View>

        {/* Linked auction quick-link */}
        {data.auction_id && (
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/lot/[id]', params: { id: data.auction_id } } as any)}
            style={s.linkedAuction}>
            <Hash size={12} color={colors.textMuted} />
            <Text style={s.linkedAuctionTxt}>VIEW LINKED LOT</Text>
          </TouchableOpacity>
        )}

        {/* Evidence */}
        <View style={s.section}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={s.sectionLbl}>EVIDENCE ({data.evidence_count})</Text>
            {!isTerminal && (
              <TouchableOpacity onPress={() => setEvOpen(true)} style={s.smallBtn}>
                <Text style={s.smallBtnTxt}>+ ADD</Text>
              </TouchableOpacity>
            )}
          </View>
          {(data.evidence || []).map((e: any) => (
            <View key={e.id} style={s.evRow}>
              <FileText size={12} color={colors.textMuted} />
              <View style={{ flex: 1, marginLeft: 6 }}>
                <Text style={s.evKind}>{e.kind?.toUpperCase()}</Text>
                <Text style={s.evMeta}>{e.note || e.filename || '—'}</Text>
                <Text style={s.tsTxt}>{new Date(e.ts).toLocaleString()}</Text>
              </View>
            </View>
          ))}
          {(data.evidence || []).length === 0 && <Text style={s.empty}>No evidence yet.</Text>}
        </View>

        {/* Messages — immutable timeline */}
        <View style={s.section}>
          <Text style={s.sectionLbl}>OPERATOR MESSAGES</Text>
          {(data.messages || []).map((m: any) => (
            <View key={m.id} style={[s.msgRow,
              m.actor_role === 'operator' && { borderLeftColor: colors.red, backgroundColor: colors.red + '11' },
              m.actor_role === 'raiser' && { borderLeftColor: '#3B82F6' },
              m.actor_role === 'counterparty' && { borderLeftColor: '#10B981' },
            ]}>
              <Text style={s.msgRole}>{m.actor_role === 'raiser' ? 'YOU' : m.actor_role.toUpperCase()}</Text>
              <Text style={s.msgBody}>{m.body}</Text>
              <Text style={s.tsTxt}>{new Date(m.ts).toLocaleString()}</Text>
            </View>
          ))}
          {(data.messages || []).length === 0 && <Text style={s.empty}>No messages yet.</Text>}
        </View>

        {data.state === 'raised' && (
          <TouchableOpacity onPress={withdraw} disabled={busy}
            style={[s.withdrawBtn, busy && { opacity: 0.5 }]}>
            <Text style={s.withdrawTxt}>WITHDRAW DISPUTE</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 90 }} />
      </ScrollView>

      {/* Composer */}
      {!isTerminal && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.composer}>
          <TextInput value={msgText} onChangeText={setMsgText} placeholder="Message to operator…"
            placeholderTextColor={colors.textMuted}
            style={s.composerInput} returnKeyType="send" onSubmitEditing={sendMsg} />
          <TouchableOpacity onPress={sendMsg} disabled={busy || !msgText.trim()}
            style={[s.composerBtn, (!msgText.trim() || busy) && { opacity: 0.5 }]}>
            <MessageCircle size={14} color={colors.text} />
          </TouchableOpacity>
        </KeyboardAvoidingView>
      )}

      {/* Evidence modal */}
      <Modal visible={evOpen} transparent animationType="fade" onRequestClose={() => setEvOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.modalRoot}>
          <TouchableOpacity activeOpacity={1} style={s.backdrop} onPress={() => setEvOpen(false)} />
          <View style={s.modalCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={s.modalTitle}>ADD EVIDENCE</Text>
              <TouchableOpacity onPress={() => setEvOpen(false)} hitSlop={8}><X size={18} color={colors.textMuted} /></TouchableOpacity>
            </View>
            <Text style={s.fieldLbl}>EVIDENCE NOTE</Text>
            <TextInput value={evNote} onChangeText={setEvNote} multiline placeholder="Describe the evidence (facts, dates, references)…"
              placeholderTextColor={colors.textMuted}
              style={[s.input, { height: 120, textAlignVertical: 'top' }]} />
            <TouchableOpacity onPress={addEvidence} disabled={busy}
              style={[s.submit, busy && { opacity: 0.5 }]}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={s.submitTxt}>SUBMIT EVIDENCE</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function Meta({ label, value, accent }: any) {
  return (
    <View style={s.metaCell}>
      <Text style={s.metaLbl}>{label}</Text>
      <Text style={[s.metaVal, accent && { color: accent }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 50, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 6 },
  headerType: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  headerTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  statePill: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 3, borderWidth: 1 },
  statePillTxt: { fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  nextStepBox: { padding: 12, marginHorizontal: 12, marginVertical: 10, borderLeftWidth: 4, backgroundColor: colors.surface, borderRadius: 4, gap: 4 },
  nextStepLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  nextStepTxt: { color: colors.text, fontSize: 12, lineHeight: 17 },
  outcomeBox: { padding: 12, marginHorizontal: 12, marginBottom: 10, borderRadius: 6, borderWidth: 1, gap: 6 },
  outcomeLbl: { fontSize: 13, fontWeight: '900', letterSpacing: 0.7 },
  outcomeReason: { color: colors.text, fontSize: 12, lineHeight: 17 },
  outcomeTs: { color: colors.textMuted, fontSize: 10 },
  metaRow: { flexDirection: 'row', paddingHorizontal: 12, gap: 6, marginBottom: 8 },
  metaCell: { flex: 1, padding: 6, alignItems: 'center', backgroundColor: colors.surface, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  metaLbl: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  metaVal: { color: colors.text, fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
  section: { padding: 12, borderTopWidth: 1, borderTopColor: colors.border, gap: 6 },
  sectionLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  descTxt: { color: colors.text, fontSize: 12, lineHeight: 17 },
  tsTxt: { color: colors.textMuted, fontSize: 9, fontWeight: '600' },
  linkedAuction: { flexDirection: 'row', alignItems: 'center', gap: 6, marginHorizontal: 12, marginBottom: 8, padding: 8, backgroundColor: colors.surface, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  linkedAuctionTxt: { color: colors.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  evRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  evKind: { color: colors.text, fontSize: 10, fontWeight: '700' },
  evMeta: { color: colors.textMuted, fontSize: 11 },
  empty: { color: colors.textMuted, fontSize: 11, fontStyle: 'italic', paddingVertical: 4 },
  msgRow: { padding: 8, borderLeftWidth: 3, backgroundColor: colors.surface, borderRadius: 4, gap: 3, marginBottom: 6 },
  msgRole: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  msgBody: { color: colors.text, fontSize: 12 },
  smallBtn: { paddingHorizontal: 8, paddingVertical: 4, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  smallBtnTxt: { color: colors.text, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  withdrawBtn: { marginHorizontal: 12, marginTop: 12, paddingVertical: 10, alignItems: 'center', borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  withdrawTxt: { color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 6, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  composerInput: { flex: 1, color: colors.text, fontSize: 12, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  composerBtn: { paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.red, borderRadius: 4 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { backgroundColor: colors.surface, padding: 16, borderTopLeftRadius: 12, borderTopRightRadius: 12, gap: 8 },
  modalTitle: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: 0.7 },
  fieldLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  input: { color: colors.text, fontSize: 12, padding: 10, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  submit: { backgroundColor: colors.red, borderRadius: 6, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  submitTxt: { color: colors.text, fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
});
