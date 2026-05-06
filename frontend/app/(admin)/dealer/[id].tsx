/**
 * Operator Dealer Detail Drawer.
 *
 * Full profile + bid history + recent logins + max-bid editor.
 * Reachable from /(admin)/dealers card tap.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import {
  ArrowLeft, BadgeCheck, Ban, ShieldCheck, Phone, MapPin, Star,
  Banknote, Save, Building2, Clock, Gavel, Activity, AlertTriangle,
} from 'lucide-react-native';
import { colors, radii, formatINR } from '../../../src/theme';
import { api } from '../../../src/api';
import { useToast } from '../../../src/toast';
import { useAuth } from '../../../src/auth';

export default function DealerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { dealer: me } = useAuth();
  const role = (me as any)?.role;
  const isOperator = ['super_admin', 'admin', 'operations_admin', 'inspection_admin'].includes(role);

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [maxBidInput, setMaxBidInput] = useState<string>('');
  const [savingMax, setSavingMax] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const d = await api.adminDealerDetail(String(id));
      setData(d);
      setMaxBidInput(d?.dealer?.max_bid_limit ? String(d.dealer.max_bid_limit) : '');
    } catch (e: any) {
      toast.show(e.message || 'Could not load dealer', 'error');
    } finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (!isOperator) {
    router.replace('/(tabs)');
    return null;
  }
  if (loading || !data) {
    return <View style={styles.loader}><ActivityIndicator color={colors.red} /></View>;
  }

  const d = data.dealer;

  const saveMaxBid = async () => {
    setSavingMax(true);
    try {
      const val = maxBidInput.trim() ? parseInt(maxBidInput.replace(/\D/g, ''), 10) : null;
      await api.adminSetMaxBid(d.id, val || null);
      toast.show(val ? `Max bid set to ${formatINR(val)}` : 'Max bid limit cleared', 'success');
      load();
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setSavingMax(false); }
  };

  const onApprove = async () => {
    setBusy(true);
    try {
      // Use the new canonical approve endpoint — captures previous_status,
      // approved_at, approved_by, ip, user-agent in audit.
      await api.adminApproveDealer(d.id, { note: 'Approved via dealer detail panel' });
      toast.show('Approved · dealer notified', 'success');
      load();
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };
  const onSuspend = () => {
    Alert.alert('Suspend dealer?', 'They will lose bidding access immediately.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Suspend', style: 'destructive', onPress: async () => {
        setBusy(true);
        try { await api.adminVerifyDealer(d.id, { suspended: true }); toast.show('Suspended', 'success'); load(); }
        catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
        finally { setBusy(false); }
      }},
    ]);
  };
  const onReinstate = async () => {
    setBusy(true);
    try { await api.adminVerifyDealer(d.id, { suspended: false }); toast.show('Reinstated', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.root}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="dealer-detail-back">
          <ArrowLeft size={18} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>DEALER DETAIL</Text>
          <Text style={styles.title} numberOfLines={1}>{d.dealership_name || d.full_name}</Text>
        </View>
        {d.suspended ? (
          <View style={[styles.statusPill, styles.statusSuspended]}><Ban size={10} color={colors.red} /><Text style={[styles.statusText, { color: colors.red }]}>SUSPENDED</Text></View>
        ) : d.verified ? (
          <View style={[styles.statusPill, styles.statusOk]}><BadgeCheck size={10} color={colors.success} /><Text style={[styles.statusText, { color: colors.success }]}>ACTIVE</Text></View>
        ) : (
          <View style={[styles.statusPill, styles.statusPending]}><AlertTriangle size={10} color={colors.warning} /><Text style={[styles.statusText, { color: colors.warning }]}>UNVERIFIED</Text></View>
        )}
      </View>

      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 80 }}>
        {/* IDENTITY block */}
        <View style={styles.card}>
          <View style={styles.cardHead}><Building2 size={13} color={colors.textChrome} /><Text style={styles.cardHeadText}>IDENTITY</Text></View>
          <Row label="Phone" icon={<Phone size={12} color={colors.textMuted} />} value={d.phone} />
          <Row label="Owner" icon={<Activity size={12} color={colors.textMuted} />} value={d.full_name || '—'} />
          <Row label="City" icon={<MapPin size={12} color={colors.textMuted} />} value={d.city || '—'} />
          <Row label="Trust score" icon={<Star size={12} color={colors.warning} />} value={`${(d.trust_score || 0).toFixed(1)} / 5`} />
          {!!data.allow_list && (
            <Row label="Allow-list status" icon={<ShieldCheck size={12} color={colors.success} />} value={`${data.allow_list.status?.toUpperCase()}`} />
          )}
        </View>

        {/* PERFORMANCE */}
        <View style={styles.card}>
          <View style={styles.cardHead}><Gavel size={13} color={colors.textChrome} /><Text style={styles.cardHeadText}>PERFORMANCE</Text></View>
          <View style={styles.kpiGrid}>
            <Kpi label="BIDS" value={`${data.bids_count || 0}`} />
            <Kpi label="WINS" value={`${data.wins_count || 0}`} tint={colors.success} />
            <Kpi label="PURCHASES" value={`${d.total_purchases || 0}`} />
          </View>
        </View>

        {/* MAX BID LIMIT — hard backend cap */}
        <View style={[styles.card, { borderColor: 'rgba(245,158,11,0.30)' }]}>
          <View style={styles.cardHead}>
            <Banknote size={13} color={colors.warning} />
            <Text style={[styles.cardHeadText, { color: colors.warning }]}>MAX BID LIMIT · HARD CAP</Text>
          </View>
          <Text style={styles.note}>Backend rejects any bid above this with 403. Leave blank for no cap.</Text>
          <View style={styles.maxRow}>
            <View style={styles.maxInputBox}>
              <Text style={styles.cc}>₹</Text>
              <TextInput
                value={maxBidInput}
                onChangeText={setMaxBidInput}
                placeholder="e.g. 1500000"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                style={styles.maxInput}
                testID="dealer-detail-maxbid-input"
              />
            </View>
            <TouchableOpacity onPress={saveMaxBid} style={[styles.saveBtn, savingMax && { opacity: 0.6 }]} disabled={savingMax} testID="dealer-detail-maxbid-save">
              <Save size={13} color="#fff" />
              <Text style={styles.saveBtnText}>{savingMax ? 'Saving…' : 'Save'}</Text>
            </TouchableOpacity>
          </View>
          {d.max_bid_limit ? (
            <Text style={styles.currentLimit}>Current cap: <Text style={{ color: colors.textPrimary, fontWeight: '900' }}>{formatINR(d.max_bid_limit)}</Text></Text>
          ) : (
            <Text style={styles.currentLimit}>No bid cap set.</Text>
          )}
        </View>

        {/* MODERATION ACTIONS */}
        <View style={styles.card}>
          <View style={styles.cardHead}><ShieldCheck size={13} color={colors.textChrome} /><Text style={styles.cardHeadText}>MODERATION</Text></View>
          <View style={styles.actionRow}>
            {!d.verified && !d.suspended && (
              <TouchableOpacity disabled={busy} onPress={onApprove} style={[styles.modBtn, styles.modApprove]} testID="dealer-detail-approve">
                <ShieldCheck size={13} color={colors.success} />
                <Text style={[styles.modText, { color: colors.success }]}>Approve</Text>
              </TouchableOpacity>
            )}
            {!d.suspended && d.verified && (
              <TouchableOpacity disabled={busy} onPress={onSuspend} style={[styles.modBtn, styles.modDanger]} testID="dealer-detail-suspend">
                <Ban size={13} color={colors.red} />
                <Text style={[styles.modText, { color: colors.red }]}>Suspend</Text>
              </TouchableOpacity>
            )}
            {d.suspended && (
              <TouchableOpacity disabled={busy} onPress={onReinstate} style={[styles.modBtn, styles.modApprove]} testID="dealer-detail-reinstate">
                <ShieldCheck size={13} color={colors.success} />
                <Text style={[styles.modText, { color: colors.success }]}>Reinstate</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* BID HISTORY */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Gavel size={13} color={colors.textChrome} />
            <Text style={styles.cardHeadText}>BID HISTORY</Text>
            <Text style={styles.cardHeadCount}>{data.recent_bids?.length || 0}</Text>
          </View>
          {!data.recent_bids?.length ? (
            <Text style={styles.empty}>No bids placed yet.</Text>
          ) : (
            data.recent_bids.slice(0, 12).map((b: any) => (
              <View key={b.id} style={styles.bidRow}>
                <View style={[styles.bidDot, b.is_top_bidder ? { backgroundColor: colors.success } : { backgroundColor: colors.textMuted }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.bidCar} numberOfLines={1}>{`${b.car?.year || ''} ${b.car?.make || ''} ${b.car?.model || ''}`.trim() || '—'}</Text>
                  <Text style={styles.bidMeta}>{b.car?.registration_number || ''} · {b.auction_status?.toUpperCase()}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.bidAmount}>{formatINR(b.amount)}</Text>
                  <Text style={styles.bidTs}>{new Date(b.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</Text>
                </View>
              </View>
            ))
          )}
        </View>

        {/* RECENT LOGINS */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Clock size={13} color={colors.textChrome} />
            <Text style={styles.cardHeadText}>RECENT LOGINS</Text>
          </View>
          {!data.recent_logins?.length ? (
            <Text style={styles.empty}>No login events recorded.</Text>
          ) : (
            data.recent_logins.map((l: any, i: number) => (
              <View key={i} style={styles.loginRow}>
                <ShieldCheck size={11} color={colors.success} />
                <Text style={styles.loginText}>{new Date(l.ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</Text>
              </View>
            ))
          )}
        </View>

        {!!data.allow_list?.notes && (
          <View style={styles.card}>
            <View style={styles.cardHead}><Activity size={13} color={colors.textChrome} /><Text style={styles.cardHeadText}>NOTES</Text></View>
            <Text style={styles.notesBody}>{data.allow_list.notes}</Text>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Row({ label, icon, value }: any) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLabel}>
        {icon}
        <Text style={styles.rowLabelText}>{label}</Text>
      </View>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}
function Kpi({ label, value, tint }: any) {
  return (
    <View style={[styles.kpi, tint && { borderColor: tint + '55' }]}>
      <Text style={[styles.kpiLabel, tint && { color: tint }]}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loader: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingTop: Platform.OS === 'ios' ? 60 : 36, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(185,28,28,0.20)' },
  iconBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kicker: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '800', marginTop: 2, letterSpacing: -0.3 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  statusOk: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  statusPending: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' },
  statusSuspended: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  statusText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },

  card: { padding: 14, borderRadius: radii.lg, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, marginBottom: 12 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  cardHeadText: { color: colors.textChrome, fontSize: 10.5, fontWeight: '900', letterSpacing: 1.2 },
  cardHeadCount: { color: colors.red, fontSize: 10.5, fontWeight: '900', marginLeft: 'auto' },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.border },
  rowLabel: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabelText: { color: colors.textMuted, fontSize: 11.5, fontWeight: '700' },
  rowValue: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '700', maxWidth: '60%', textAlign: 'right' },

  kpiGrid: { flexDirection: 'row', gap: 8 },
  kpi: { flex: 1, padding: 10, borderRadius: radii.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  kpiLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1 },
  kpiValue: { color: colors.textPrimary, fontSize: 22, fontWeight: '900', marginTop: 4, letterSpacing: -0.4, fontVariant: ['tabular-nums'] },

  note: { color: colors.textChrome, fontSize: 11.5, lineHeight: 16, marginBottom: 10 },
  maxRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  maxInputBox: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: 12 },
  cc: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  maxInput: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: '700', paddingVertical: 12, fontVariant: ['tabular-nums'] },
  saveBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 11, borderRadius: radii.md, backgroundColor: colors.warning },
  saveBtnText: { color: '#fff', fontSize: 12.5, fontWeight: '900', letterSpacing: 0.4 },
  currentLimit: { color: colors.textChrome, fontSize: 11.5, marginTop: 9, fontWeight: '600' },

  actionRow: { flexDirection: 'row', gap: 8 },
  modBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1 },
  modApprove: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  modDanger: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  modText: { fontSize: 12, fontWeight: '900', letterSpacing: 0.4 },

  bidRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  bidDot: { width: 8, height: 8, borderRadius: 4 },
  bidCar: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '700' },
  bidMeta: { color: colors.textMuted, fontSize: 10.5, marginTop: 2, letterSpacing: 0.4 },
  bidAmount: { color: colors.textPrimary, fontSize: 13, fontWeight: '900', fontVariant: ['tabular-nums'] },
  bidTs: { color: colors.textMuted, fontSize: 10, marginTop: 2, fontVariant: ['tabular-nums'] },

  loginRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 5 },
  loginText: { color: colors.textChrome, fontSize: 11.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  notesBody: { color: colors.textPrimary, fontSize: 12.5, lineHeight: 18 },
  empty: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 14 },
});
