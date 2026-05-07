/**
 * Dealer Disputes — list + Raise New flow.
 *
 * Constraints (per product brief):
 *   • Operational + evidence-driven feel.
 *   • Linked auction reference visible.
 *   • SLA aging visible (so dealer knows status).
 *   • "What happens next" clarity for every dispute.
 *   • No chat surface, no social.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import {
  ChevronLeft, ChevronRight, Plus, X, Clock, Flame, Hash,
} from 'lucide-react-native';
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
  raised: 'Operator will review and either decide or request evidence.',
  under_review: 'Operator is reviewing. You may add evidence or messages.',
  evidence_pending: 'Operator has requested specific evidence. Upload it below.',
  decided: 'Operator has decided. Resolution will be applied shortly.',
  resolved: 'Closed. Outcome is final.',
  withdrawn: 'Closed by withdrawal.',
};

export default function MyDisputes() {
  const router = useRouter();
  const params = useLocalSearchParams<{ raise?: string; auction_id?: string }>();
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [raiseOpen, setRaiseOpen] = useState(!!params?.raise);
  const [types, setTypes] = useState<any[]>([]);
  const [type, setType] = useState<string>('payment_delay');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const auctionId = params?.auction_id;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, ts] = await Promise.all([
        api.disputesMine(),
        types.length ? Promise.resolve(types) : api.disputeTypes(),
      ]);
      setItems(list || []);
      if (!types.length) setTypes(ts || []);
    } catch (e: any) { toast.show(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [types.length, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const submit = async () => {
    if (title.trim().length < 3 || desc.trim().length < 10) {
      toast.show('Title ≥3 chars, description ≥10 chars', 'error');
      return;
    }
    setBusy(true);
    try {
      const created = await api.raiseDispute({
        dispute_type: type,
        title: title.trim(),
        description: desc.trim(),
        auction_id: auctionId || null,
      });
      toast.show('Dispute raised', 'success');
      setRaiseOpen(false);
      setTitle(''); setDesc('');
      await load();
      // Open the new dispute detail
      router.push({ pathname: '/my-disputes/[id]', params: { id: created.id } } as any);
    } catch (e: any) {
      toast.show(e.message || 'Failed to raise', 'error');
    } finally { setBusy(false); }
  };

  const open = useMemo(() => items.filter((i: any) => !['resolved', 'withdrawn'].includes(i.state)), [items]);
  const closed = useMemo(() => items.filter((i: any) => ['resolved', 'withdrawn'].includes(i.state)), [items]);

  return (
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <ChevronLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>MY DISPUTES</Text>
        <TouchableOpacity onPress={() => setRaiseOpen(true)} style={s.raiseBtn} testID="raise-dispute-cta">
          <Plus size={14} color={colors.text} />
          <Text style={s.raiseTxt}>RAISE</Text>
        </TouchableOpacity>
      </View>

      {loading && items.length === 0 ? (
        <View style={{ padding: 40, alignItems: 'center' }}><ActivityIndicator color={colors.red} /></View>
      ) : (
        <ScrollView refreshControl={
          <RefreshControl refreshing={refreshing}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            tintColor={colors.red} />}>
          {open.length === 0 && closed.length === 0 && (
            <View style={s.emptyBox}>
              <Text style={s.emptyTitle}>No disputes raised.</Text>
              <Text style={s.emptyHint}>Use "Raise" if you have a verified issue with a counterparty.</Text>
            </View>
          )}
          {open.length > 0 && (
            <View>
              <Text style={s.sectionLbl}>OPEN ({open.length})</Text>
              {open.map((d: any) => <DisputeRow key={d.id} d={d} onPress={() => router.push({ pathname: '/my-disputes/[id]', params: { id: d.id } } as any)} />)}
            </View>
          )}
          {closed.length > 0 && (
            <View style={{ marginTop: 12 }}>
              <Text style={s.sectionLbl}>CLOSED ({closed.length})</Text>
              {closed.map((d: any) => <DisputeRow key={d.id} d={d} closed onPress={() => router.push({ pathname: '/my-disputes/[id]', params: { id: d.id } } as any)} />)}
            </View>
          )}
          <View style={{ height: 80 }} />
        </ScrollView>
      )}

      {/* Raise modal */}
      <Modal visible={raiseOpen} transparent animationType="fade" onRequestClose={() => setRaiseOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.modalRoot}>
          <TouchableOpacity activeOpacity={1} style={s.backdrop} onPress={() => setRaiseOpen(false)} />
          <ScrollView style={s.modalCard} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={s.modalTitle}>RAISE NEW DISPUTE</Text>
              <TouchableOpacity onPress={() => setRaiseOpen(false)} hitSlop={8}><X size={18} color={colors.textMuted} /></TouchableOpacity>
            </View>
            {auctionId && (
              <View style={s.linkedBox}>
                <Hash size={11} color={colors.textMuted} />
                <Text style={s.linkedTxt}>LINKED AUCTION · {auctionId.slice(0, 8)}…</Text>
              </View>
            )}
            <Text style={s.fieldLbl}>DISPUTE TYPE</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {types.map(t => (
                <TouchableOpacity key={t.key} onPress={() => setType(t.key)}
                  style={[s.typeChip, type === t.key && s.typeChipActive]}>
                  <Text style={[s.typeChipTxt, type === t.key && { color: colors.text }]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {types.find(t => t.key === type) && (
              <Text style={s.typeDesc}>{types.find(t => t.key === type)?.description}</Text>
            )}
            <Text style={s.fieldLbl}>TITLE</Text>
            <TextInput value={title} onChangeText={setTitle} placeholder="Brief summary"
              placeholderTextColor={colors.textMuted}
              maxLength={200} style={s.input} />
            <Text style={s.fieldLbl}>DESCRIPTION</Text>
            <TextInput value={desc} onChangeText={setDesc} placeholder="What happened, when, who, amounts…"
              placeholderTextColor={colors.textMuted}
              maxLength={5000} multiline style={[s.input, { height: 120, textAlignVertical: 'top' }]} />
            <Text style={s.warnTxt}>
              ⚠  False or frivolous disputes are tracked and impact your trust score.
            </Text>
            <TouchableOpacity onPress={submit} disabled={busy}
              style={[s.submit, busy && { opacity: 0.5 }]}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={s.submitTxt}>SUBMIT FOR OPERATOR REVIEW</Text>}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function DisputeRow({ d, onPress, closed }: any) {
  const sevColor = SEVERITY_COLOR[d.aging?.severity || 'ok'];
  return (
    <TouchableOpacity onPress={onPress} style={s.row} activeOpacity={0.7}>
      <View style={[s.rail, { backgroundColor: sevColor }]} />
      <View style={{ flex: 1, padding: 10, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={[s.statePill, { borderColor: sevColor }]}>
            <Text style={[s.statePillTxt, { color: sevColor }]}>{STATE_LABEL[d.state] || d.state.toUpperCase()}</Text>
          </View>
          {d.is_escalated && (
            <View style={s.escBadge}><Flame size={10} color={colors.red} /><Text style={s.escTxt}>ESC</Text></View>
          )}
          <View style={{ flex: 1 }} />
          {!closed && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Clock size={11} color={colors.textMuted} />
              <Text style={s.ageTxt}>{(d.aging?.elapsed_hours || 0).toFixed(1)}H</Text>
            </View>
          )}
        </View>
        <Text style={s.title} numberOfLines={1}>{d.title}</Text>
        <Text style={s.metaLine}>{d.type_label}{d.auction_id ? ` · lot ${d.auction_id.slice(0, 6)}…` : ''}</Text>
        <Text style={s.nextStep}>{NEXT_STEP[d.state] || ''}</Text>
      </View>
      <ChevronRight size={16} color={colors.textMuted} style={{ marginRight: 6 }} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 50, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 },
  headerTitle: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: 0.7, flex: 1 },
  raiseBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.red, borderRadius: 4 },
  raiseTxt: { color: colors.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  emptyBox: { padding: 30, alignItems: 'center', gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  emptyHint: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  sectionLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7, paddingHorizontal: 12, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface, marginHorizontal: 8, marginBottom: 6, borderRadius: 6, borderWidth: 1, overflow: 'hidden' },
  rail: { width: 4 },
  statePill: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, borderWidth: 1 },
  statePillTxt: { fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  escBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 3, borderWidth: 1, borderColor: colors.red },
  escTxt: { color: colors.red, fontSize: 8, fontWeight: '900' },
  ageTxt: { color: colors.textMuted, fontSize: 10, fontVariant: ['tabular-nums'], fontWeight: '700' },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  metaLine: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  nextStep: { color: colors.textMuted, fontSize: 10, fontStyle: 'italic' },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { backgroundColor: colors.surface, padding: 16, borderTopLeftRadius: 12, borderTopRightRadius: 12, maxHeight: '85%' },
  modalTitle: { color: colors.text, fontSize: 14, fontWeight: '900', letterSpacing: 0.7 },
  fieldLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7, marginTop: 10, marginBottom: 4 },
  linkedBox: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  linkedTxt: { color: colors.textMuted, fontSize: 10, fontWeight: '800' },
  typeChip: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  typeChipActive: { backgroundColor: colors.red + '22', borderColor: colors.red },
  typeChipTxt: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  typeDesc: { color: colors.textMuted, fontSize: 11, marginTop: 6, fontStyle: 'italic' },
  input: { color: colors.text, fontSize: 12, padding: 10, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  warnTxt: { color: '#F59E0B', fontSize: 10, marginTop: 8, fontWeight: '600' },
  submit: { backgroundColor: colors.red, borderRadius: 6, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  submitTxt: { color: colors.text, fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
});
