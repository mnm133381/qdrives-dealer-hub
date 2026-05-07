/**
 * Operator Reputation Drilldown.
 *
 * Tabs: SIGNALS │ TIMELINE │ ACTIONS │ NOTES
 * Action panel exposes: Adjust Score · Suspend · Cooldown · Shadow ·
 *                       Force KYC · Flag · Lift Restriction · Add Note.
 * Every action recorded in operator_actions_audit (server-side).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, ShieldX, Pause, Eye, FileWarning, Flag, X, Lock, Plus, Minus } from 'lucide-react-native';
import { colors } from '../../../src/theme';
import { api } from '../../../src/api';
import { useToast } from '../../../src/toast';

const TABS = ['SIGNALS', 'TIMELINE', 'ACTIONS', 'NOTES'] as const;

export default function AdminReputationDetail() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const dealerId = String(id || '');
  const toast = useToast();
  const [tab, setTab] = useState<typeof TABS[number]>('SIGNALS');
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionModal, setActionModal] = useState<null | { kind: string; title: string; needsDuration?: boolean; needsDelta?: boolean }>(null);
  const [reasonText, setReasonText] = useState('');
  const [duration, setDuration] = useState('24');
  const [delta, setDelta] = useState('-5');
  const [busy, setBusy] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteVis, setNoteVis] = useState<'operator' | 'dealer'>('operator');

  const load = useCallback(async () => {
    if (!dealerId) return;
    setLoading(true);
    try {
      const r = await api.adminReputationDealer(dealerId);
      setData(r);
    } catch (e: any) { toast.show(e.message || 'Failed to load', 'error'); }
    finally { setLoading(false); }
  }, [dealerId, toast]);

  useEffect(() => { load(); }, [load]);

  const openAction = (kind: string, title: string, needsDuration?: boolean, needsDelta?: boolean) => {
    setReasonText('');
    setDuration(kind === 'cooldown' ? '24' : '');
    setDelta('-5');
    setActionModal({ kind, title, needsDuration, needsDelta });
  };

  const runAction = async () => {
    if (!actionModal) return;
    if (reasonText.trim().length < 3) { toast.show('Reason required (min 3 chars)', 'error'); return; }
    setBusy(true);
    try {
      const reason = reasonText.trim();
      const dh = duration ? parseInt(duration, 10) : null;
      switch (actionModal.kind) {
        case 'adjust':
          await api.adminReputationAdjust(dealerId, parseInt(delta, 10) || 0, reason); break;
        case 'flag':
          await api.adminReputationFlag(dealerId, reason); break;
        case 'suspend':
          await api.adminReputationSuspend(dealerId, reason, dh); break;
        case 'cooldown':
          await api.adminReputationCooldown(dealerId, reason, dh || 24); break;
        case 'shadow':
          await api.adminReputationShadow(dealerId, reason, dh); break;
        case 'force-kyc':
          await api.adminReputationForceKyc(dealerId, reason); break;
        case 'lift-suspended':
          await api.adminReputationLift(dealerId, 'suspended', reason); break;
        case 'lift-cooldown':
          await api.adminReputationLift(dealerId, 'bidding_cooldown', reason); break;
        case 'lift-shadow':
          await api.adminReputationLift(dealerId, 'shadow_restricted', reason); break;
        case 'lift-kyc':
          await api.adminReputationLift(dealerId, 'kyc_review', reason); break;
      }
      toast.show('Action recorded', 'success');
      setActionModal(null);
      await load();
    } catch (e: any) { toast.show(e.message || 'Action failed', 'error'); }
    finally { setBusy(false); }
  };

  const submitNote = async () => {
    if (noteText.trim().length === 0) { toast.show('Note empty', 'error'); return; }
    setBusy(true);
    try {
      await api.adminReputationAddNote(dealerId, noteText.trim(), noteVis);
      toast.show('Note added', 'success');
      setNoteText('');
      await load();
    } catch (e: any) { toast.show(e.message || 'Note failed', 'error'); }
    finally { setBusy(false); }
  };

  if (loading || !data) {
    return <View style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}><ActivityIndicator color={colors.red} /></View>;
  }

  const rep = data.reputation;
  const dealer = data.dealer;
  const tierColor = rep.tier?.color || colors.text;

  const activeRestrictions = rep.restrictions || [];
  const hasSuspended = activeRestrictions.some((r: any) => r.kind === 'suspended');
  const hasCooldown = activeRestrictions.some((r: any) => r.kind === 'bidding_cooldown');
  const hasShadow = activeRestrictions.some((r: any) => r.kind === 'shadow_restricted');
  const hasKyc = activeRestrictions.some((r: any) => r.kind === 'kyc_review');

  return (
    <View style={s.root}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <ChevronLeft size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text style={s.headerTitle} numberOfLines={1}>{dealer.name || 'Dealer'}</Text>
          <Text style={s.headerSub}>{dealer.phone}</Text>
        </View>
        <View style={[s.scoreBadge, { borderColor: tierColor }]}>
          <Text style={[s.scoreVal, { color: tierColor }]}>{rep.score}</Text>
        </View>
      </View>

      <View style={s.tierBar}>
        <View style={[s.tierBig, { backgroundColor: tierColor + '22', borderColor: tierColor }]}>
          <Text style={[s.tierBigTxt, { color: tierColor }]}>{(rep.tier?.label || '').toUpperCase()}</Text>
        </View>
        {activeRestrictions.length > 0 && (
          <View style={{ flexDirection: 'row', gap: 4, flex: 1, flexWrap: 'wrap' }}>
            {activeRestrictions.map((r: any) => (
              <View key={r.id} style={[s.restrictBadge]}>
                <Lock size={10} color={colors.red} />
                <Text style={s.restrictBadgeTxt}>{r.kind.toUpperCase().replace(/_/g, ' ')}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* Tabs */}
      <View style={s.tabs}>
        {TABS.map(t => (
          <TouchableOpacity key={t} onPress={() => setTab(t)}
            style={[s.tab, tab === t && s.tabActive]}>
            <Text style={[s.tabTxt, tab === t && s.tabTxtActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.red} />
      }>
        {tab === 'SIGNALS' && (
          <View style={s.body}>
            <View style={s.calc}>
              <Text style={s.calcLine}>BASE <Text style={s.calcVal}>{rep.base_score}</Text></Text>
              {Object.entries(rep.category_deltas || {}).map(([k, v]) => (
                <Text key={k} style={s.calcLine}>{k.toUpperCase()} <Text style={[s.calcVal, { color: (v as number) >= 0 ? '#10B981' : colors.red }]}>{(v as number) >= 0 ? '+' : ''}{v as any}</Text></Text>
              ))}
              <View style={s.calcSep} />
              <Text style={[s.calcLine, { fontSize: 14 }]}>FINAL <Text style={[s.calcVal, { color: tierColor, fontSize: 18 }]}>{rep.score}</Text></Text>
            </View>
            {(rep.signals || []).filter((sg: any) => sg.count > 0).map((sg: any) => (
              <View key={sg.kind} style={s.sigCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={s.sigLabel}>{sg.label}</Text>
                  <Text style={[s.sigDelta, { color: sg.delta >= 0 ? '#10B981' : colors.red }]}>{sg.delta >= 0 ? '+' : ''}{sg.delta}</Text>
                </View>
                <Text style={s.sigDesc}>{sg.description}</Text>
                <View style={s.sigMeta}>
                  <Text style={s.sigMetaTxt}>{sg.window.toUpperCase()} · COUNT {sg.count} · WEIGHT {sg.weight_per > 0 ? '+' : ''}{sg.weight_per}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {tab === 'TIMELINE' && (
          <View style={s.body}>
            {(data.timeline || []).map((t: any) => (
              <View key={t.id} style={s.timeRow}>
                <View style={s.timeDot} />
                <View style={{ flex: 1 }}>
                  <Text style={s.timeKind}>{t.label || t.kind}</Text>
                  <Text style={s.timeMeta}>{new Date(t.ts).toLocaleString()} · {(t.source || '').toUpperCase()}{t.note ? ` · ${t.note}` : ''}</Text>
                </View>
              </View>
            ))}
            {(!data.timeline || data.timeline.length === 0) && (
              <Text style={s.empty}>No reputation events yet.</Text>
            )}
          </View>
        )}

        {tab === 'ACTIONS' && (
          <View style={s.body}>
            <Text style={s.sectionLbl}>SIGNAL OVERRIDES</Text>
            <ActionRow icon={<Plus size={16} color={colors.text} />} label="ADJUST SCORE" hint="Manual ± delta" onPress={() => openAction('adjust', 'Adjust Score', false, true)} />
            <ActionRow icon={<Flag size={16} color={colors.red} />} label="OPERATOR FLAG" hint="-20 lifetime, audit-logged" onPress={() => openAction('flag', 'Operator Flag')} />
            <ActionRow icon={<FileWarning size={16} color={'#F59E0B'} />} label="FORCE KYC REVIEW" hint="Re-verification required" onPress={() => openAction('force-kyc', 'Force KYC Review')} />
            <Text style={s.sectionLbl}>RESTRICTIONS</Text>
            <ActionRow icon={<Pause size={16} color={'#F59E0B'} />} label={hasCooldown ? 'BIDDING COOLDOWN ACTIVE' : 'BIDDING COOLDOWN'} hint="Block bids, hours" onPress={() => openAction('cooldown', 'Bidding Cooldown', true)} />
            <ActionRow icon={<Eye size={16} color={'#7C3AED'} />} label={hasShadow ? 'SHADOW ACTIVE' : 'SHADOW RESTRICT'} hint="Hide from marketplace" onPress={() => openAction('shadow', 'Shadow Restriction', true)} />
            <ActionRow icon={<ShieldX size={16} color={colors.red} />} label={hasSuspended ? 'SUSPENSION ACTIVE' : 'FULL SUSPEND'} hint="Kill session, block all" onPress={() => openAction('suspend', 'Full Suspension', true)} danger />
            {(hasSuspended || hasCooldown || hasShadow || hasKyc) && (
              <>
                <Text style={s.sectionLbl}>LIFT</Text>
                {hasSuspended && <ActionRow label="LIFT SUSPENSION" onPress={() => openAction('lift-suspended', 'Lift Suspension')} />}
                {hasCooldown && <ActionRow label="LIFT COOLDOWN" onPress={() => openAction('lift-cooldown', 'Lift Cooldown')} />}
                {hasShadow && <ActionRow label="LIFT SHADOW" onPress={() => openAction('lift-shadow', 'Lift Shadow')} />}
                {hasKyc && <ActionRow label="LIFT KYC HOLD" onPress={() => openAction('lift-kyc', 'Lift KYC Hold')} />}
              </>
            )}
            <Text style={s.sectionLbl}>OPERATOR AUDIT (recent)</Text>
            {(data.operator_audit || []).slice(0, 20).map((a: any) => (
              <View key={a.id} style={s.auditRow}>
                <Text style={s.auditAction}>{a.action.toUpperCase().replace(/_/g, ' ')}</Text>
                <Text style={s.auditMeta}>{new Date(a.ts).toLocaleString()}{a.reason ? ` · ${a.reason}` : ''}</Text>
              </View>
            ))}
            {(!data.operator_audit || data.operator_audit.length === 0) && (
              <Text style={s.empty}>No operator actions yet.</Text>
            )}
          </View>
        )}

        {tab === 'NOTES' && (
          <View style={s.body}>
            <View style={s.noteForm}>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TouchableOpacity onPress={() => setNoteVis('operator')} style={[s.visTab, noteVis === 'operator' && s.visTabActive]}>
                  <Text style={[s.visTxt, noteVis === 'operator' && s.visTxtActive]}>OPERATORS ONLY</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setNoteVis('dealer')} style={[s.visTab, noteVis === 'dealer' && s.visTabActive]}>
                  <Text style={[s.visTxt, noteVis === 'dealer' && s.visTxtActive]}>VISIBLE TO DEALER</Text>
                </TouchableOpacity>
              </View>
              <TextInput value={noteText} onChangeText={setNoteText} placeholder="Note text…"
                placeholderTextColor={colors.textMuted} multiline
                style={s.noteInput} />
              <TouchableOpacity onPress={submitNote} disabled={busy} style={[s.noteSubmit, busy && { opacity: 0.6 }]}>
                <Text style={s.noteSubmitTxt}>ADD NOTE</Text>
              </TouchableOpacity>
            </View>
            {(data.operator_notes || []).map((n: any) => (
              <View key={n.id} style={s.noteCard}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={s.noteVisChip}>{n.visibility?.toUpperCase()}</Text>
                  <Text style={s.auditMeta}>{new Date(n.created_at).toLocaleString()}</Text>
                </View>
                <Text style={s.noteBody}>{n.note}</Text>
              </View>
            ))}
            {(!data.operator_notes || data.operator_notes.length === 0) && (
              <Text style={s.empty}>No notes yet.</Text>
            )}
          </View>
        )}

        <View style={{ height: 80 }} />
      </ScrollView>

      {/* Action modal */}
      <Modal visible={!!actionModal} transparent animationType="fade" onRequestClose={() => setActionModal(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.modalRoot}>
          <TouchableOpacity activeOpacity={1} style={s.modalBackdrop} onPress={() => setActionModal(null)} />
          <View style={s.modalCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text style={s.modalTitle}>{actionModal?.title}</Text>
              <TouchableOpacity onPress={() => setActionModal(null)} hitSlop={8}><X size={18} color={colors.textMuted} /></TouchableOpacity>
            </View>
            {actionModal?.needsDelta && (
              <View style={s.field}>
                <Text style={s.fieldLbl}>SCORE DELTA</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {[-20, -10, -5, +5, +10].map(v => (
                    <TouchableOpacity key={v} onPress={() => setDelta(String(v))}
                      style={[s.deltaChip, parseInt(delta, 10) === v && s.deltaChipActive]}>
                      <Text style={[s.deltaChipTxt, parseInt(delta, 10) === v && { color: colors.text }]}>{v > 0 ? '+' : ''}{v}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput value={delta} onChangeText={setDelta} keyboardType="numbers-and-punctuation"
                  placeholderTextColor={colors.textMuted} style={s.input} />
              </View>
            )}
            {actionModal?.needsDuration && (
              <View style={s.field}>
                <Text style={s.fieldLbl}>DURATION (HOURS)</Text>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {[1, 24, 72, 168, 720].map(v => (
                    <TouchableOpacity key={v} onPress={() => setDuration(String(v))}
                      style={[s.deltaChip, duration === String(v) && s.deltaChipActive]}>
                      <Text style={[s.deltaChipTxt, duration === String(v) && { color: colors.text }]}>{v}H</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput value={duration} onChangeText={setDuration} keyboardType="number-pad"
                  placeholder="hours (blank = open-ended)" placeholderTextColor={colors.textMuted}
                  style={s.input} />
              </View>
            )}
            <View style={s.field}>
              <Text style={s.fieldLbl}>REASON (REQUIRED)</Text>
              <TextInput value={reasonText} onChangeText={setReasonText} multiline
                placeholder="Audit log entry…" placeholderTextColor={colors.textMuted}
                style={[s.input, { height: 80, textAlignVertical: 'top' }]} />
            </View>
            <TouchableOpacity onPress={runAction} disabled={busy}
              style={[s.modalCta, busy && { opacity: 0.5 }]}>
              {busy ? <ActivityIndicator color={colors.text} /> : <Text style={s.modalCtaTxt}>CONFIRM ACTION</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function ActionRow({ icon, label, hint, onPress, danger }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={[s.actionRow, danger && { borderColor: colors.red + '88' }]} activeOpacity={0.7}>
      {icon && <View style={{ width: 24, alignItems: 'center' }}>{icon}</View>}
      <View style={{ flex: 1 }}>
        <Text style={[s.actionLabel, danger && { color: colors.red }]}>{label}</Text>
        {hint && <Text style={s.actionHint}>{hint}</Text>}
      </View>
      <Text style={s.actionArrow}>›</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 50, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  headerSub: { color: colors.textMuted, fontSize: 11, fontVariant: ['tabular-nums'] },
  scoreBadge: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  scoreVal: { fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'] },
  tierBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  tierBig: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1 },
  tierBigTxt: { fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  restrictBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 3, borderWidth: 1, borderColor: colors.red },
  restrictBadgeTxt: { color: colors.red, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.red },
  tabTxt: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  tabTxtActive: { color: colors.text },
  body: { padding: 12, gap: 8 },
  calc: { backgroundColor: colors.surface, borderRadius: 6, padding: 12, gap: 4, borderWidth: 1, borderColor: colors.border },
  calcLine: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, fontVariant: ['tabular-nums'] },
  calcVal: { color: colors.text, fontWeight: '900' },
  calcSep: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  sigCard: { backgroundColor: colors.surface, borderRadius: 6, padding: 10, borderWidth: 1, borderColor: colors.border, gap: 4 },
  sigLabel: { color: colors.text, fontSize: 12, fontWeight: '700' },
  sigDelta: { fontSize: 14, fontWeight: '900', fontVariant: ['tabular-nums'] },
  sigDesc: { color: colors.textMuted, fontSize: 10 },
  sigMeta: {},
  sigMetaTxt: { color: colors.textMuted, fontSize: 9, fontVariant: ['tabular-nums'], letterSpacing: 0.4 },
  timeRow: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  timeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red, marginTop: 5 },
  timeKind: { color: colors.text, fontSize: 12, fontWeight: '700' },
  timeMeta: { color: colors.textMuted, fontSize: 10 },
  empty: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 20 },
  sectionLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 0.8, marginTop: 6, marginBottom: 2 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.surface, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
  actionLabel: { color: colors.text, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  actionHint: { color: colors.textMuted, fontSize: 10 },
  actionArrow: { color: colors.textMuted, fontSize: 18, fontWeight: '300' },
  auditRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  auditAction: { color: colors.text, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  auditMeta: { color: colors.textMuted, fontSize: 9 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { backgroundColor: colors.surface, padding: 16, borderTopLeftRadius: 12, borderTopRightRadius: 12, gap: 10, borderTopWidth: 1, borderTopColor: colors.border },
  modalTitle: { color: colors.text, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  field: { gap: 6 },
  fieldLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  input: { color: colors.text, fontSize: 12, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  deltaChip: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  deltaChipActive: { borderColor: colors.red, backgroundColor: colors.red + '22' },
  deltaChipTxt: { color: colors.textMuted, fontSize: 10, fontWeight: '700' },
  modalCta: { backgroundColor: colors.red, borderRadius: 6, paddingVertical: 12, alignItems: 'center', marginTop: 6 },
  modalCtaTxt: { color: colors.text, fontSize: 13, fontWeight: '900', letterSpacing: 0.6 },
  noteForm: { gap: 8, marginBottom: 8 },
  visTab: { flex: 1, paddingVertical: 6, alignItems: 'center', borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  visTabActive: { borderColor: colors.red, backgroundColor: colors.red + '22' },
  visTxt: { color: colors.textMuted, fontSize: 9, fontWeight: '800' },
  visTxtActive: { color: colors.text },
  noteInput: { color: colors.text, fontSize: 12, padding: 10, backgroundColor: colors.surface, borderRadius: 4, borderWidth: 1, borderColor: colors.border, minHeight: 80, textAlignVertical: 'top' },
  noteSubmit: { backgroundColor: colors.red, borderRadius: 4, paddingVertical: 8, alignItems: 'center' },
  noteSubmitTxt: { color: colors.text, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  noteCard: { backgroundColor: colors.surface, padding: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.border, gap: 4 },
  noteVisChip: { color: colors.textMuted, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
  noteBody: { color: colors.text, fontSize: 12 },
});
