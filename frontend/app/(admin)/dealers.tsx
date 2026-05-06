/**
 * Dealer Management · Approval Queue.
 *
 * Trading-terminal split view of the entire onboarding pipeline:
 *   1. INVITATIONS — phones added to allow-list, never logged in yet.
 *   2. ONBOARDING — logged in, KYC pending.
 *   3. ACTIVE — verified + KYC complete (live trading dealers).
 *   4. SUSPENDED — manually paused.
 *   5. REVOKED — allow-list entry removed.
 *
 * Operator-only quick actions: Add to allow-list (Option B — pre-fill
 * full profile), open dealer detail, suspend / reinstate. Detailed
 * mutations live on /(admin)/dealer/[id].
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  RefreshControl, TextInput, Modal, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Search, BadgeCheck, Ban, ShieldCheck, Phone, MapPin, AlertTriangle,
  UserPlus, X, Building2, User, Star, Banknote, FileText, ChevronRight, Hash,
} from 'lucide-react-native';
import { colors, radii, formatINR } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';
import { AdminHeader } from '../../src/components/AdminHeader';

type Tab = 'invitations' | 'onboarding' | 'active' | 'suspended' | 'revoked';

export default function AdminDealers() {
  const toast = useToast();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('active');
  const [q, setQ] = useState('');
  const [allowList, setAllowList] = useState<any[]>([]);
  const [dealers, setDealers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [allow, dealersResp] = await Promise.all([
        api.adminApprovedDealers({ q: q || undefined }),
        api.adminDealers({ q: q || undefined }),
      ]);
      setAllowList(allow as any[]);
      setDealers(dealersResp as any[]);
    } catch (e: any) {
      toast.show(e.message || 'Could not load dealers', 'error');
    } finally { setLoading(false); }
  }, [q]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Build the per-tab segmented list
  const invitations = allowList.filter((a) => a.onboarding === 'never_logged_in' && a.status === 'active');
  const onboarding = allowList.filter((a) => a.onboarding === 'kyc_pending' && a.status === 'active');
  const activeDealers = dealers.filter((d) => d.verified && !d.suspended);
  const suspendedDealers = dealers.filter((d) => d.suspended);
  const revokedAllow = allowList.filter((a) => a.status === 'revoked');

  const counts = {
    invitations: invitations.length,
    onboarding: onboarding.length,
    active: activeDealers.length,
    suspended: suspendedDealers.length,
    revoked: revokedAllow.length,
  };

  const onSuspend = async (id: string) => {
    Alert.alert('Suspend dealer?', 'They will lose bidding access immediately and the allow-list entry will remain intact for audit.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Suspend', style: 'destructive', onPress: async () => {
        try { await api.adminVerifyDealer(id, { suspended: true }); toast.show('Suspended', 'success'); load(); }
        catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
      }}]);
  };
  const onReinstate = async (id: string) => {
    try { await api.adminVerifyDealer(id, { suspended: false }); toast.show('Reinstated', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };
  const onApprove = async (id: string) => {
    try { await api.adminApproveDealer(id, { note: 'Approved from approval queue' }); toast.show('Approved · dealer notified', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };

  return (
    <View style={styles.root}>
      <AdminHeader
        kicker="Dealer network"
        title="Approval queue"
        sub="Open dealer onboarding · pending dealers cannot bid until approved"
        rightSlot={(
          <TouchableOpacity onPress={() => setShowAdd(true)} style={styles.addBtn} activeOpacity={0.85} testID="admin-add-dealer-btn">
            <UserPlus size={13} color="#fff" />
            <Text style={styles.addBtnText}>ADD</Text>
          </TouchableOpacity>
        )}
      />

      <View style={styles.searchBox}>
        <Search size={14} color={colors.textMuted} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search phone, dealership, name, city"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCapitalize="none"
          onSubmitEditing={load}
          returnKeyType="search"
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
        <SegTab label="INVITATIONS" count={counts.invitations} active={tab === 'invitations'} onPress={() => setTab('invitations')} tint={colors.warning} />
        <SegTab label="ONBOARDING" count={counts.onboarding} active={tab === 'onboarding'} onPress={() => setTab('onboarding')} tint={colors.silver} />
        <SegTab label="ACTIVE" count={counts.active} active={tab === 'active'} onPress={() => setTab('active')} tint={colors.success} />
        <SegTab label="SUSPENDED" count={counts.suspended} active={tab === 'suspended'} onPress={() => setTab('suspended')} tint={colors.red} />
        <SegTab label="REVOKED" count={counts.revoked} active={tab === 'revoked'} onPress={() => setTab('revoked')} tint={colors.textMuted} />
      </ScrollView>

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {loading && allowList.length === 0 ? (
          <View style={styles.empty}><ActivityIndicator color={colors.red} /></View>
        ) : (
          <>
            {tab === 'invitations' && <AllowListCards items={invitations} kind="invitations" onTap={(p) => router.push({ pathname: '/(admin)/dealers', params: {} })} />}
            {tab === 'onboarding' && <AllowListCards items={onboarding} kind="onboarding" />}
            {tab === 'active' && <DealerCards items={activeDealers} onSuspend={onSuspend} onApprove={onApprove} onTap={(d) => router.push(`/(admin)/dealer/${d.id}` as any)} />}
            {tab === 'suspended' && <DealerCards items={suspendedDealers} onReinstate={onReinstate} onTap={(d) => router.push(`/(admin)/dealer/${d.id}` as any)} />}
            {tab === 'revoked' && <AllowListCards items={revokedAllow} kind="revoked" />}
          </>
        )}
      </ScrollView>

      <AddDealerModal visible={showAdd} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); load(); toast.show('Allow-list updated', 'success'); }} />
    </View>
  );
}

function SegTab({ label, count, active, onPress, tint }: any) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.segTab, active && { borderColor: tint, backgroundColor: tint + '10' }]}>
      <Text style={[styles.segTabText, active && { color: tint }]}>{label}</Text>
      <View style={[styles.segCount, active && { backgroundColor: tint }]}>
        <Text style={[styles.segCountText, active && { color: '#fff' }]}>{count}</Text>
      </View>
    </TouchableOpacity>
  );
}

function AllowListCards({ items, kind }: { items: any[]; kind: 'invitations' | 'onboarding' | 'revoked'; onTap?: (phone: string) => void }) {
  if (!items.length) return <View style={styles.empty}><Text style={styles.emptyText}>Nothing here.</Text></View>;
  return (
    <>
      {items.map((a) => (
        <View key={a.phone} style={styles.card} testID={`allow-${kind}-${a.phone}`}>
          <View style={styles.cardRow}>
            <View style={styles.miniAvatar}><User size={16} color={colors.textChrome} /></View>
            <View style={{ flex: 1 }}>
              <View style={styles.titleRow}>
                <Text style={styles.dealershipText} numberOfLines={1}>{a.dealership_name || '(no dealership)'}</Text>
                <View style={[styles.kindPill, kind === 'invitations' ? { borderColor: 'rgba(245,158,11,0.4)', backgroundColor: 'rgba(245,158,11,0.10)' } : kind === 'revoked' ? { borderColor: colors.border, backgroundColor: colors.bg } : { borderColor: 'rgba(160,160,160,0.4)', backgroundColor: 'rgba(160,160,160,0.10)' }]}>
                  <Text style={[styles.kindPillText, kind === 'invitations' && { color: colors.warning }, kind === 'revoked' && { color: colors.textMuted }, kind === 'onboarding' && { color: colors.silver }]}>
                    {kind === 'invitations' ? 'INVITED' : kind === 'onboarding' ? 'KYC PENDING' : 'REVOKED'}
                  </Text>
                </View>
              </View>
              <View style={styles.metaRow}><Phone size={10} color={colors.textMuted} /><Text style={styles.metaText}>{a.phone}</Text></View>
              <View style={styles.metaRow}><MapPin size={10} color={colors.textMuted} /><Text style={styles.metaText}>{a.city || '—'}</Text></View>
              {!!a.full_name && <Text style={styles.metaText2}>{a.full_name}</Text>}
            </View>
          </View>
          <View style={styles.allowFooter}>
            <View style={styles.allowFooterChip}><Star size={10} color={colors.warning} /><Text style={styles.allowFooterChipText}>{(a.trust_score || 0).toFixed(1)}</Text></View>
            <View style={styles.allowFooterChip}><Banknote size={10} color={colors.success} /><Text style={styles.allowFooterChipText}>{a.max_bid_limit ? formatINR(a.max_bid_limit) : 'No cap'}</Text></View>
            {!!a.notes && <View style={[styles.allowFooterChip, { flex: 1 }]}><FileText size={10} color={colors.textMuted} /><Text style={styles.allowFooterChipText} numberOfLines={1}>{a.notes}</Text></View>}
          </View>
        </View>
      ))}
    </>
  );
}

function DealerCards({ items, onSuspend, onReinstate, onApprove, onTap }: any) {
  if (!items.length) return <View style={styles.empty}><Text style={styles.emptyText}>No dealers here.</Text></View>;
  return (
    <>
      {items.map((d: any) => (
        <TouchableOpacity key={d.id} style={styles.card} activeOpacity={0.85} onPress={() => onTap?.(d)} testID={`dealer-card-${d.id}`}>
          <View style={styles.cardRow}>
            <View style={styles.miniAvatar}><Building2 size={16} color={colors.textChrome} /></View>
            <View style={{ flex: 1 }}>
              <View style={styles.titleRow}>
                <Text style={styles.dealershipText} numberOfLines={1}>{d.dealership_name || d.full_name || 'Unnamed'}</Text>
                {d.suspended ? (
                  <View style={[styles.statusPill, styles.statusSuspended]}><Ban size={9} color={colors.red} /><Text style={[styles.statusText, { color: colors.red }]}>SUSPENDED</Text></View>
                ) : d.verified ? (
                  <View style={[styles.statusPill, styles.statusOk]}><BadgeCheck size={9} color={colors.success} /><Text style={[styles.statusText, { color: colors.success }]}>ACTIVE</Text></View>
                ) : (
                  <View style={[styles.statusPill, styles.statusPending]}><AlertTriangle size={9} color={colors.warning} /><Text style={[styles.statusText, { color: colors.warning }]}>UNVERIFIED</Text></View>
                )}
              </View>
              <View style={styles.metaRow}><Phone size={10} color={colors.textMuted} /><Text style={styles.metaText}>{d.phone}</Text></View>
              <View style={styles.metaRow}><MapPin size={10} color={colors.textMuted} /><Text style={styles.metaText}>{d.city || '—'}</Text></View>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </View>
          <View style={styles.statsRow}>
            <Stat label="BIDS" value={`${d.bids_count || 0}`} />
            <Stat label="WINS" value={`${d.wins_count || 0}`} />
            <Stat label="TRUST" value={`${(d.trust_score || 0).toFixed(1)}★`} />
            <Stat label="MAX BID" value={d.max_bid_limit ? formatINR(d.max_bid_limit) : '∞'} />
          </View>
          <View style={styles.actions}>
            {!d.verified && !d.suspended && (
              <TouchableOpacity onPress={() => onApprove(d.id)} style={[styles.actionBtn, styles.actionApprove]}>
                <ShieldCheck size={12} color={colors.success} />
                <Text style={[styles.actionText, { color: colors.success }]}>Approve</Text>
              </TouchableOpacity>
            )}
            {!d.suspended && d.verified && (
              <TouchableOpacity onPress={() => onSuspend(d.id)} style={[styles.actionBtn, styles.actionDanger]}>
                <Ban size={12} color={colors.red} />
                <Text style={[styles.actionText, { color: colors.red }]}>Suspend</Text>
              </TouchableOpacity>
            )}
            {d.suspended && (
              <TouchableOpacity onPress={() => onReinstate(d.id)} style={[styles.actionBtn, styles.actionApprove]}>
                <ShieldCheck size={12} color={colors.success} />
                <Text style={[styles.actionText, { color: colors.success }]}>Reinstate</Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      ))}
    </>
  );
}

function Stat({ label, value }: any) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function AddDealerModal({ visible, onClose, onAdded }: any) {
  const toast = useToast();
  const [form, setForm] = useState({
    phone: '', full_name: '', dealership_name: '', city: '',
    trust_score: '4.5', max_bid_limit: '', notes: '',
  });
  const [busy, setBusy] = useState(false);
  const upd = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!form.phone || form.phone.length < 10) {
      Alert.alert('Phone required', 'Enter a valid 10-digit Indian mobile (E.164 + or local).');
      return;
    }
    const e164 = form.phone.startsWith('+') ? form.phone : `+91${form.phone.replace(/\D/g, '')}`;
    setBusy(true);
    try {
      await api.adminAddApprovedDealer({
        phone: e164,
        full_name: form.full_name,
        dealership_name: form.dealership_name,
        city: form.city,
        trust_score: form.trust_score ? parseFloat(form.trust_score) : 4.5,
        max_bid_limit: form.max_bid_limit ? parseInt(form.max_bid_limit, 10) : null,
        notes: form.notes,
      });
      onAdded();
      setForm({ phone: '', full_name: '', dealership_name: '', city: '', trust_score: '4.5', max_bid_limit: '', notes: '' });
    } catch (e: any) {
      toast.show(e.message || 'Failed to add dealer', 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ width: '100%' }}>
          <View style={styles.modalCard}>
            <View style={styles.modalHead}>
              <View style={styles.modalIcon}><UserPlus size={16} color={colors.red} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalKicker}>ALLOW-LIST · ADD DEALER</Text>
                <Text style={styles.modalTitle}>Pre-fill new dealer</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}><X size={16} color={colors.textChrome} /></TouchableOpacity>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
              <Field icon={<Hash size={14} color={colors.textChrome} />} label="Phone (with country code)" value={form.phone} onChange={(v: string) => upd('phone', v)} placeholder="+91XXXXXXXXXX" testID="add-dealer-phone" keyboardType="phone-pad" />
              <Field icon={<User size={14} color={colors.textChrome} />} label="Full name" value={form.full_name} onChange={(v: string) => upd('full_name', v)} placeholder="Owner / proprietor" testID="add-dealer-name" />
              <Field icon={<Building2 size={14} color={colors.textChrome} />} label="Dealership name" value={form.dealership_name} onChange={(v: string) => upd('dealership_name', v)} placeholder="e.g. Apex Premium Motors" testID="add-dealer-dealership" />
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Field icon={<MapPin size={14} color={colors.textChrome} />} label="City" value={form.city} onChange={(v: string) => upd('city', v)} placeholder="Mumbai" testID="add-dealer-city" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field icon={<Star size={14} color={colors.warning} />} label="Trust score (0–5)" value={form.trust_score} onChange={(v: string) => upd('trust_score', v)} placeholder="4.5" testID="add-dealer-trust" keyboardType="decimal-pad" />
                </View>
              </View>
              <Field icon={<Banknote size={14} color={colors.success} />} label="Max bid limit (₹)" value={form.max_bid_limit} onChange={(v: string) => upd('max_bid_limit', v)} placeholder="e.g. 1500000" testID="add-dealer-maxbid" keyboardType="number-pad" />
              <Field icon={<FileText size={14} color={colors.textChrome} />} label="Notes" value={form.notes} onChange={(v: string) => upd('notes', v)} placeholder="Risk tier / referral / notes" testID="add-dealer-notes" />
            </ScrollView>
            <TouchableOpacity disabled={busy} onPress={submit} style={[styles.modalCta, busy && { opacity: 0.5 }]} testID="add-dealer-submit">
              <Text style={styles.modalCtaText}>{busy ? 'Adding…' : 'Add to allow-list'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function Field({ icon, label, value, onChange, placeholder, testID, keyboardType }: any) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldBox}>
        {icon}
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          style={styles.fieldInput}
          testID={testID}
          keyboardType={keyboardType || 'default'}
          autoCapitalize="words"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 20, paddingTop: 6, paddingBottom: 60 },

  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.red },
  addBtnText: { color: '#fff', fontSize: 10.5, fontWeight: '900', letterSpacing: 0.7 },

  searchBox: { marginHorizontal: 20, marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: 12, paddingVertical: 9 },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: '600' },

  tabsRow: { gap: 8, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
  segTab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 },
  segTabText: { color: colors.textChrome, fontSize: 9.5, fontWeight: '900', letterSpacing: 1 },
  segCount: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, minWidth: 20, alignItems: 'center' },
  segCountText: { color: colors.textChrome, fontSize: 9, fontWeight: '900' },

  empty: { paddingVertical: 60, alignItems: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },

  card: { padding: 13, borderRadius: radii.lg, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, marginBottom: 10 },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  miniAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  dealershipText: { flex: 1, color: colors.textPrimary, fontSize: 13.5, fontWeight: '800', letterSpacing: -0.2 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  statusOk: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  statusPending: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' },
  statusSuspended: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  statusText: { fontSize: 8.5, fontWeight: '900', letterSpacing: 0.8 },
  kindPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  kindPillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  metaText: { color: colors.textChrome, fontSize: 11.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
  metaText2: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  allowFooter: { flexDirection: 'row', gap: 7, marginTop: 11, paddingTop: 9, borderTopWidth: 1, borderTopColor: colors.border, flexWrap: 'wrap' },
  allowFooterChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  allowFooterChipText: { color: colors.textChrome, fontSize: 10.5, fontWeight: '700' },
  statsRow: { flexDirection: 'row', gap: 8, marginTop: 11, paddingTop: 11, borderTopWidth: 1, borderTopColor: colors.border },
  stat: { flex: 1 },
  statLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  statValue: { color: colors.textPrimary, fontSize: 13.5, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  actionApprove: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  actionDanger: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  actionText: { fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalCard: { backgroundColor: colors.bgElevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '88%', borderTopWidth: 1.5, borderColor: 'rgba(185,28,28,0.4)' },
  modalHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  modalIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(185,28,28,0.12)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)', alignItems: 'center', justifyContent: 'center' },
  modalKicker: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  modalTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', letterSpacing: -0.3, marginTop: 1 },
  closeBtn: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  modalCta: { paddingVertical: 14, borderRadius: radii.md, backgroundColor: colors.red, alignItems: 'center', marginTop: 4 },
  modalCtaText: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },

  field: { marginBottom: 11 },
  fieldLabel: { color: colors.textChrome, fontSize: 10.5, fontWeight: '900', letterSpacing: 0.7, marginBottom: 6 },
  fieldBox: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 12, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md },
  fieldInput: { flex: 1, color: colors.textPrimary, fontSize: 13.5, fontWeight: '600', paddingVertical: 12 },
});
