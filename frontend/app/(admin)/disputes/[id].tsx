/**
 * Operator Dispute Detail — evidence + chat + decision panel.
 *
 * Sections: header w/ aging, party reputations inline, type info,
 * evidence list (downloadable on tap), chat trail, audit log,
 * action panel (Take Review · Request Evidence · Escalate · Decide).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, AlertOctagon, Flame, Clock, FileText, X, MessageCircle } from 'lucide-react-native';
import { colors } from '../../../src/theme';
import { api } from '../../../src/api';
import { useToast } from '../../../src/toast';

const SEVERITY_COLOR: Record<string, string> = {
  ok: '#10B981', warning: '#FBBF24', breach: '#F59E0B',
  critical: '#DC2626', closed: '#6B7280',
};

const OUTCOMES = [
  { key: 'decided_for_raiser', label: 'For Raiser', color: '#10B981' },
  { key: 'decided_against_raiser', label: 'Against Raiser', color: '#DC2626' },
  { key: 'decided_inconclusive', label: 'Inconclusive', color: '#FBBF24' },
  { key: 'frivolous', label: 'Frivolous', color: '#7C3AED' },
];

export default function AdminDisputeDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const did = String(id || '');
  const toast = useToast();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [msgText, setMsgText] = useState('');
  const [actionModal, setActionModal] = useState<null | 'request_evidence' | 'escalate' | 'decide'>(null);
  const [reasonText, setReasonText] = useState('');
  const [outcome, setOutcome] = useState<string>('decided_for_raiser');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!did) return;
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

  const takeReview = async () => {
    setBusy(true);
    try { await api.adminDisputeTakeReview(did); toast.show('Marked under review', 'success'); await load(); }
    catch (e: any) { toast.show(e.message || 'Action failed', 'error'); }
    finally { setBusy(false); }
  };

  const runModal = async () => {
    if (reasonText.trim().length < 3) { toast.show('Reason required', 'error'); return; }
    setBusy(true);
    try {
      if (actionModal === 'request_evidence') await api.adminDisputeRequestEvidence(did, reasonText.trim());
      else if (actionModal === 'escalate') await api.adminDisputeEscalate(did, reasonText.trim());
      else if (actionModal === 'decide') await api.adminDisputeDecide(did, outcome, reasonText.trim());
      toast.show('Recorded', 'success');
      setActionModal(null);
      setReasonText('');
      await load();
    } catch (e: any) { toast.show(e.message || 'Action failed', 'error'); }
    finally { setBusy(false); }
  };

  if (loading || !data) {
    return <View style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}><ActivityIndicator color={colors.red} /></View>;
  }

  const sev = data.aging?.severity || 'ok';
  const sevColor = SEVERITY_COLOR[sev];
  const isTerminal = data.is_terminal;

  return (
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <ChevronLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 6 }}>
          <Text style={s.headerType} numberOfLines={1}>{data.type_label}</Text>
          <Text style={s.headerTitle} numberOfLines={2}>{data.title}</Text>
        </View>
        <View style={[s.statePill, { borderColor: sevColor }]}>
          <Text style={[s.statePillTxt, { color: sevColor }]}>{(data.state || '').toUpperCase().replace(/_/g, ' ')}</Text>
        </View>
      </View>

      <View style={[s.metaRow, { borderLeftColor: sevColor }]}>
        <View style={s.metaCell}>
          <Text style={s.metaLbl}>AGING</Text>
          <Text style={[s.metaVal, { color: sevColor }]}>{(data.aging?.elapsed_hours || 0).toFixed(1)}H</Text>
        </View>
        <View style={s.metaCell}>
          <Text style={s.metaLbl}>SLA RES</Text>
          <Text style={s.metaVal}>{data.sla_resolve_hours}H</Text>
        </View>
        <View style={s.metaCell}>
          <Text style={s.metaLbl}>PRIORITY</Text>
          <Text style={s.metaVal}>P{data.priority_score}</Text>
        </View>
        {data.is_escalated && (
          <View style={[s.metaCell, { backgroundColor: colors.red + '22' }]}>
            <Flame size={12} color={colors.red} />
            <Text style={[s.metaLbl, { color: colors.red }]}>ESCALATED</Text>
          </View>
        )}
      </View>

      <ScrollView style={{ flex: 1 }} refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.red} />
      }>
        <View style={s.section}>
          <Text style={s.sectionLbl}>DESCRIPTION</Text>
          <Text style={s.descText}>{data.description}</Text>
        </View>

        <View style={s.section}>
          <Text style={s.sectionLbl}>EVIDENCE ({data.evidence_count})</Text>
          {(data.evidence || []).map((e: any) => (
            <View key={e.id} style={s.evRow}>
              <FileText size={14} color={colors.textMuted} />
              <View style={{ flex: 1, marginLeft: 8 }}>
                <Text style={s.evKind}>{e.kind?.toUpperCase()}</Text>
                <Text style={s.evMeta}>{e.filename || e.note || '—'} · {new Date(e.ts).toLocaleString()}</Text>
              </View>
            </View>
          ))}
          {(data.evidence || []).length === 0 && <Text style={s.empty}>No evidence yet.</Text>}
        </View>

        <View style={s.section}>
          <Text style={s.sectionLbl}>CHAT TRAIL ({data.message_count})</Text>
          {(data.messages || []).map((m: any) => (
            <View key={m.id} style={[s.msgRow,
              m.actor_role === 'operator' && { borderLeftColor: colors.red, backgroundColor: colors.red + '11' },
              m.actor_role === 'raiser' && { borderLeftColor: '#3B82F6' },
              m.actor_role === 'counterparty' && { borderLeftColor: '#10B981' },
            ]}>
              <Text style={s.msgRole}>{m.actor_role?.toUpperCase()}</Text>
              <Text style={s.msgBody}>{m.body}</Text>
              <Text style={s.msgTs}>{new Date(m.ts).toLocaleString()}</Text>
            </View>
          ))}
          {(data.messages || []).length === 0 && <Text style={s.empty}>No messages yet.</Text>}
        </View>

        {!isTerminal && (
          <View style={s.section}>
            <Text style={s.sectionLbl}>OPERATOR ACTIONS</Text>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              {data.state === 'raised' && (
                <TouchableOpacity onPress={takeReview} disabled={busy} style={[s.opBtn]}>
                  <Text style={s.opBtnTxt}>TAKE REVIEW</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => { setReasonText(''); setActionModal('request_evidence'); }} style={s.opBtn}>
                <Text style={s.opBtnTxt}>REQUEST EVIDENCE</Text>
              </TouchableOpacity>
              {!data.is_escalated && (
                <TouchableOpacity onPress={() => { setReasonText(''); setActionModal('escalate'); }} style={[s.opBtn, { borderColor: '#F59E0B' }]}>
                  <Text style={[s.opBtnTxt, { color: '#F59E0B' }]}>ESCALATE</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => { setReasonText(''); setOutcome('decided_for_raiser'); setActionModal('decide'); }} style={[s.opBtn, { backgroundColor: colors.red, borderColor: colors.red }]}>
                <Text style={[s.opBtnTxt, { color: colors.text }]}>DECIDE</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {data.audit && (
          <View style={s.section}>
            <Text style={s.sectionLbl}>STATE AUDIT</Text>
            {(data.audit || []).map((a: any) => (
              <View key={a.id} style={s.auditRow}>
                <Text style={s.auditAction}>{a.action.toUpperCase()} {a.from_state ? `→ ${a.to_state.toUpperCase()}` : ''}</Text>
                <Text style={s.auditMeta}>{new Date(a.ts).toLocaleString()}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 80 }} />
      </ScrollView>

      {!isTerminal && (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.composer}>
          <TextInput value={msgText} onChangeText={setMsgText} placeholder="Operator message…"
            placeholderTextColor={colors.textMuted}
            style={s.composerInput}
            onSubmitEditing={sendMsg} returnKeyType="send" />
          <TouchableOpacity onPress={sendMsg} disabled={busy || !msgText.trim()}
            style={[s.composerBtn, (!msgText.trim() || busy) && { opacity: 0.5 }]}>
            <MessageCircle size={14} color={colors.text} />
            <Text style={s.composerBtnTxt}>SEND</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      )}

      {/* Action modal */}
      <Modal visible={!!actionModal} transparent animationType="fade" onRequestClose={() => setActionModal(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.modalRoot}>
          <TouchableOpacity activeOpacity={1} style={s.modalBackdrop} onPress={() => setActionModal(null)} />
          <View style={s.modalCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={s.modalTitle}>
                {actionModal === 'request_evidence' && 'REQUEST EVIDENCE'}
                {actionModal === 'escalate' && 'ESCALATE DISPUTE'}
                {actionModal === 'decide' && 'OPERATOR DECISION'}
              </Text>
              <TouchableOpacity onPress={() => setActionModal(null)} hitSlop={8}><X size={18} color={colors.textMuted} /></TouchableOpacity>
            </View>
            {actionModal === 'decide' && (
              <View style={{ gap: 6 }}>
                <Text style={s.fieldLbl}>OUTCOME</Text>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {OUTCOMES.map(o => (
                    <TouchableOpacity key={o.key} onPress={() => setOutcome(o.key)}
                      style={[s.outcomeChip, outcome === o.key && { backgroundColor: o.color + '22', borderColor: o.color }]}>
                      <Text style={[s.outcomeChipTxt, outcome === o.key && { color: o.color }]}>{o.label.toUpperCase()}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            <Text style={s.fieldLbl}>{actionModal === 'request_evidence' ? 'WHAT TO PROVIDE' : 'REASON'}</Text>
            <TextInput value={reasonText} onChangeText={setReasonText} multiline
              placeholder="…" placeholderTextColor={colors.textMuted}
              style={[s.modalInput, { height: 100, textAlignVertical: 'top' }]} />
            <TouchableOpacity onPress={runModal} disabled={busy}
              style={[s.modalCta, busy && { opacity: 0.5 }]}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={s.modalCtaTxt}>CONFIRM</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  metaRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, borderLeftWidth: 4, gap: 0 },
  metaCell: { flex: 1, paddingVertical: 8, paddingHorizontal: 10, gap: 2, borderRightWidth: 1, borderRightColor: colors.border, alignItems: 'center' },
  metaLbl: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  metaVal: { color: colors.text, fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] },
  section: { padding: 12, gap: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  sectionLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  descText: { color: colors.text, fontSize: 12, lineHeight: 18 },
  evRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  evKind: { color: colors.text, fontSize: 11, fontWeight: '700' },
  evMeta: { color: colors.textMuted, fontSize: 10 },
  empty: { color: colors.textMuted, fontSize: 11, fontStyle: 'italic', paddingVertical: 6 },
  msgRow: { padding: 8, borderLeftWidth: 3, backgroundColor: colors.surface, borderRadius: 4, gap: 3, marginBottom: 6 },
  msgRole: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  msgBody: { color: colors.text, fontSize: 12 },
  msgTs: { color: colors.textMuted, fontSize: 9 },
  opBtn: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  opBtnTxt: { color: colors.text, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  auditRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  auditAction: { color: colors.text, fontSize: 11, fontWeight: '700' },
  auditMeta: { color: colors.textMuted, fontSize: 9 },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 6, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  composerInput: { flex: 1, color: colors.text, fontSize: 12, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  composerBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.red, borderRadius: 4 },
  composerBtnTxt: { color: colors.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { backgroundColor: colors.surface, padding: 16, borderTopLeftRadius: 12, borderTopRightRadius: 12, gap: 10 },
  modalTitle: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: 0.6 },
  fieldLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.6 },
  modalInput: { color: colors.text, fontSize: 12, padding: 10, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  outcomeChip: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  outcomeChipTxt: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 0.4 },
  modalCta: { backgroundColor: colors.red, borderRadius: 6, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  modalCtaTxt: { color: colors.text, fontSize: 13, fontWeight: '900', letterSpacing: 0.6 },
});
