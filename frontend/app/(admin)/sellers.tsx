/**
 * Operator Sellers console.
 *
 * Create seller \u2192 link to a vehicle (car) \u2192 send access \u2192
 * monitor lifecycle (pending / access_sent / viewed / active / revoked).
 * Append-only audit visible per-seller.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, Modal, Pressable, KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  Users, UserPlus, Send, Ban, Link2, ChevronRight, Clock, X, Activity,
  CheckCircle2, ShieldCheck,
} from 'lucide-react-native';
import { colors, radii, useTabBottomPad } from '../../src/theme';
import { api } from '../../src/api';
import { AdminHeader } from '../../src/components/AdminHeader';
import { useToast } from '../../src/toast';

const STATUS_TINT: Record<string, string> = {
  pending: colors.silver,
  access_sent: colors.warning,
  viewed: colors.info,
  active: colors.success,
  revoked: colors.red,
};

const STATUSES = ['all', 'pending', 'access_sent', 'viewed', 'active', 'revoked'];

export default function AdminSellers() {
  const tabPad = useTabBottomPad();
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.adminSellersList(filter === 'all' ? undefined : filter, 200);
      setItems(r || []);
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setLoading(false); }
  }, [filter]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openDetail = async (id: string) => {
    setDetailId(id);
    try {
      const r = await api.adminSellerDetail(id);
      setDetail(r);
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };

  const closeDetail = () => { setDetailId(null); setDetail(null); };

  return (
    <View style={styles.root}>
      <AdminHeader kicker="Sellers" title="Vehicle Owners" sub="Operator-controlled visibility · read-only tracking" />
      <View style={styles.toolbar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {STATUSES.map((s) => (
            <TouchableOpacity
              key={s} onPress={() => setFilter(s)}
              style={[styles.chip, filter === s && styles.chipActive]}
            >
              <Text style={[styles.chipText, filter === s && styles.chipTextActive]}>{s.toUpperCase().replace('_', ' ')}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity onPress={() => setCreating(true)} style={styles.addBtn} testID="seller-add">
          <UserPlus size={13} color={colors.red} />
          <Text style={styles.addBtnText}>NEW</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: tabPad }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {loading ? (
          <View style={styles.loadWrap}><ActivityIndicator color={colors.red} /></View>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <Users size={20} color={colors.textChrome} />
            <Text style={styles.emptyTitle}>No sellers yet</Text>
            <Text style={styles.emptyBody}>Create a seller and link them to a vehicle to begin owner tracking.</Text>
          </View>
        ) : (
          items.map((s) => {
            const tint = STATUS_TINT[s.status] || colors.silver;
            return (
              <TouchableOpacity
                key={s.id} onPress={() => openDetail(s.id)} style={styles.row}
                activeOpacity={0.92} testID={`seller-row-${s.id}`}
              >
                <View style={[styles.statusDot, { backgroundColor: tint }]} />
                <View style={{ flex: 1 }}>
                  <View style={styles.rowHead}>
                    <Text style={styles.name} numberOfLines={1}>{s.name || '—'}</Text>
                    <View style={[styles.statusPill, { borderColor: tint + '88', backgroundColor: tint + '14' }]}>
                      <Text style={[styles.statusText, { color: tint }]}>{(s.status || '').toUpperCase().replace('_', ' ')}</Text>
                    </View>
                  </View>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {s.phone} · {s.linked_vehicles_count || 0} vehicle{s.linked_vehicles_count === 1 ? '' : 's'}
                  </Text>
                </View>
                <ChevronRight size={14} color={colors.textMuted} />
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {creating && (
        <CreateSellerModal
          onClose={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await load(); toast.show('Seller created', 'success'); }}
        />
      )}
      {detailId && (
        <SellerDetailModal
          seller={detail} onClose={closeDetail}
          onAction={async () => { await openDetail(detailId); await load(); }}
        />
      )}
    </View>
  );
}

function CreateSellerModal({ onClose, onCreated }: any) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const digits = phone.replace(/\D/g, '');
    if (!name.trim() || digits.length !== 10) { toast.show('Name + 10-digit phone required', 'error'); return; }
    setBusy(true);
    try { await api.adminSellersCreate(name.trim(), `+91${digits}`, email.trim() || undefined); await onCreated(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <Pressable style={styles.bd} onPress={onClose}>
          <Pressable style={[styles.sheet, { maxHeight: '88%' }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>New Seller</Text>
              <TouchableOpacity onPress={onClose} style={styles.sheetClose}><X size={16} color={colors.textChrome} /></TouchableOpacity>
            </View>
            <ScrollView
              contentContainerStyle={{ padding: 18, paddingBottom: 80 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={styles.fLabel}>Name</Text>
              <TextInput value={name} onChangeText={setName} placeholder="Vehicle owner full name" placeholderTextColor={colors.textMuted} style={styles.input} returnKeyType="next" />
              <Text style={styles.fLabel}>Phone (10-digit)</Text>
              <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={10} placeholder="9876543210" placeholderTextColor={colors.textMuted} style={styles.input} returnKeyType="next" />
              <Text style={styles.fLabel}>Email (optional)</Text>
              <TextInput value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="owner@email.com" placeholderTextColor={colors.textMuted} style={styles.input} returnKeyType="done" onSubmitEditing={submit} />
              <TouchableOpacity onPress={submit} disabled={busy} style={[styles.modalCta, busy && { opacity: 0.5 }]} testID="seller-create-submit">
                <Text style={styles.modalCtaText}>{busy ? 'CREATING…' : 'CREATE SELLER'}</Text>
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function SellerDetailModal({ seller, onClose, onAction }: any) {
  const toast = useToast();
  const [regQuery, setRegQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);

  // Debounced search by registration number
  React.useEffect(() => {
    const q = (regQuery || '').trim();
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try { setResults(await api.adminSellerLookupVehicle(q)); }
      catch { setResults([]); }
      finally { setSearching(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [regQuery]);

  if (!seller) return (
    <Modal visible transparent><Pressable style={styles.bd} onPress={onClose}><View style={styles.sheet}><ActivityIndicator color={colors.red} style={{ padding: 40 }} /></View></Pressable></Modal>
  );
  const tint = STATUS_TINT[seller.status] || colors.silver;
  const linkByReg = async (reg: string) => {
    if (!reg.trim()) { toast.show('Enter a registration', 'error'); return; }
    setBusy(true);
    try {
      await api.adminSellerLinkVehicle(seller.id, { registration_number: reg.trim() });
      setRegQuery(''); setResults([]);
      await onAction(); toast.show('Vehicle linked', 'success');
    }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };
  const send = async () => {
    setBusy(true);
    try { await api.adminSellerSendAccess(seller.id); await onAction(); toast.show('Access OTP dispatched (Firebase Phone Auth)', 'success'); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };
  const revoke = async () => {
    setBusy(true);
    try { await api.adminSellerRevoke(seller.id, 'operator action'); await onAction(); toast.show('Access revoked', 'success'); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <Pressable style={styles.bd} onPress={onClose}>
          <Pressable style={[styles.sheet, { maxHeight: '92%' }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>{seller.name || '—'}</Text>
                <Text style={[styles.statusText, { color: tint, marginTop: 4 }]}>{(seller.status || '').toUpperCase().replace('_', ' ')}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.sheetClose}><X size={16} color={colors.textChrome} /></TouchableOpacity>
            </View>
            <ScrollView
              contentContainerStyle={{ padding: 18, paddingBottom: 80 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.kvCard}>
                <KV k="Phone" v={seller.phone || '—'} />
                {seller.email && <KV k="Email" v={seller.email} />}
                <KV k="Created" v={new Date(seller.created_at).toLocaleString('en-IN')} />
                {seller.last_login_at && <KV k="Last login" v={new Date(seller.last_login_at).toLocaleString('en-IN')} />}
              </View>

              <Text style={styles.fLabel}>Linked vehicles · {(seller.vehicles || []).length}</Text>
              {(seller.vehicles || []).map((v: any) => (
                <View key={v.id} style={styles.veh}>
                  <Text style={styles.vehTitle}>{v.year} {v.make} {v.model}</Text>
                  <Text style={styles.vehSub}>{v.registration_number || '—'} · {(v.auction_status || '').toUpperCase()}</Text>
                </View>
              ))}

              {seller.status !== 'revoked' && (
                <>
                  <Text style={styles.fLabel}>Link vehicle by registration</Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TextInput
                      value={regQuery}
                      onChangeText={(t) => setRegQuery(t.toUpperCase())}
                      placeholder="e.g. TS09AB1234"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      style={[styles.input, { flex: 1, fontVariant: ['tabular-nums'], letterSpacing: 1 }]}
                      testID="seller-reg-input"
                    />
                    <TouchableOpacity onPress={() => linkByReg(regQuery)} disabled={busy || !regQuery.trim()} style={[styles.linkBtn, (busy || !regQuery.trim()) && { opacity: 0.5 }]} testID="seller-link-vehicle">
                      <Link2 size={13} color={colors.textChrome} />
                    </TouchableOpacity>
                  </View>

                  {/* Search results */}
                  {searching ? (
                    <View style={styles.searchHint}><ActivityIndicator size="small" color={colors.textMuted} /></View>
                  ) : results.length > 0 ? (
                    <View style={{ marginTop: 8, gap: 6 }}>
                      {results.map((v: any) => {
                        const taken = v.already_linked_seller_id && v.already_linked_seller_id !== seller.id;
                        return (
                          <TouchableOpacity
                            key={v.car_id} disabled={taken || busy}
                            onPress={() => linkByReg(v.registration_number)}
                            activeOpacity={0.85}
                            style={[styles.searchRow, taken && { opacity: 0.45 }]}
                          >
                            <View style={styles.searchPlate}>
                              <Text style={styles.searchPlateText}>{v.registration_number}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.searchTitle} numberOfLines={1}>
                                {v.year} {v.make} {v.model}
                              </Text>
                              <Text style={styles.searchSub} numberOfLines={1}>
                                {v.variant || '—'}{taken ? ' · already linked to another seller' : ''}
                              </Text>
                            </View>
                            <ChevronRight size={13} color={colors.textMuted} />
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ) : regQuery.trim().length >= 2 ? (
                    <Text style={styles.searchHintText}>No vehicle on file with this registration.</Text>
                  ) : (
                    <Text style={styles.searchHintText}>Type at least 2 characters of the registration to search.</Text>
                  )}

                  <View style={styles.actionsRow}>
                    <TouchableOpacity onPress={send} disabled={busy} style={[styles.actionBtn, styles.actionPrimary]} testID="seller-send-access">
                      <Send size={13} color="#fff" />
                      <Text style={styles.actionPrimaryText}>SEND ACCESS</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={revoke} disabled={busy} style={[styles.actionBtn, styles.actionDanger]} testID="seller-revoke">
                      <Ban size={13} color={colors.red} />
                      <Text style={styles.actionDangerText}>REVOKE</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}

              <Text style={styles.fLabel}>Audit ledger</Text>
              {(seller.audit || []).map((a: any) => (
                <View key={a.id} style={styles.audit}>
                  <Activity size={11} color={colors.textChrome} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.auditAction}>{(a.action || '').toUpperCase().replace(/_/g, ' ')}</Text>
                    <Text style={styles.auditMeta}>{new Date(a.ts).toLocaleString('en-IN')} · {a.actor_role}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function KV({ k, v }: any) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvK}>{k}</Text>
      <Text style={styles.kvV} numberOfLines={2}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10 },
  chip: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: 'rgba(255,30,45,0.10)', borderColor: colors.red },
  chipText: { color: colors.textChrome, fontSize: 9.5, fontWeight: '900', letterSpacing: 0.8 },
  chipTextActive: { color: colors.red },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(255,30,45,0.10)', borderWidth: 1, borderColor: 'rgba(255,30,45,0.45)' },
  addBtnText: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1 },

  loadWrap: { padding: 30, alignItems: 'center' },
  empty: { padding: 26, alignItems: 'center', borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', marginTop: 10 },
  emptyBody: { color: colors.textChrome, fontSize: 12, fontWeight: '500', textAlign: 'center', marginTop: 5, lineHeight: 17 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, marginBottom: 10, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: colors.textPrimary, fontSize: 13, fontWeight: '900', flex: 1 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  statusText: { fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },
  rowSub: { color: colors.textChrome, fontSize: 10.5, fontWeight: '500', marginTop: 3, fontVariant: ['tabular-nums'] },

  bd: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bgElevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1.5, borderColor: 'rgba(255,30,45,0.40)', maxHeight: '85%' },
  sheetHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginVertical: 8 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  sheetTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '900', letterSpacing: -0.3 },
  sheetClose: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },

  fLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4, marginTop: 14, marginBottom: 6 },
  input: { backgroundColor: colors.bgCard, color: colors.textPrimary, padding: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, fontSize: 13, fontWeight: '500' },
  linkBtn: { width: 44, height: 44, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },

  kvCard: { padding: 12, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, gap: 8 },
  kvRow: { flexDirection: 'row', gap: 12 },
  kvK: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 0.8, width: 80 },
  kvV: { color: colors.textPrimary, fontSize: 12, fontWeight: '600', flex: 1 },

  veh: { padding: 11, marginBottom: 6, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  vehTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '800' },
  vehSub: { color: colors.textChrome, fontSize: 10.5, fontWeight: '500', marginTop: 3 },

  // Registration-search affordances
  searchHint: { paddingVertical: 12, alignItems: 'center' },
  searchHintText: { color: colors.textMuted, fontSize: 10.5, fontWeight: '500', marginTop: 8, fontStyle: 'italic' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radii.md, backgroundColor: colors.bgDeep, borderWidth: 1, borderColor: colors.border },
  searchPlate: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: '#FFFFFF' },
  searchPlateText: { color: '#0B0B0D', fontSize: 11, fontWeight: '900', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  searchTitle: { color: colors.textPrimary, fontSize: 12, fontWeight: '800' },
  searchSub: { color: colors.textChrome, fontSize: 10.5, fontWeight: '500', marginTop: 2 },

  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  actionBtn: { flexGrow: 1, flexShrink: 1, flexBasis: 140, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, paddingHorizontal: 14 },
  actionPrimary: { backgroundColor: colors.red },
  actionPrimaryText: { color: '#fff', fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  actionDanger: { backgroundColor: 'rgba(255,30,45,0.08)', borderWidth: 1, borderColor: 'rgba(255,30,45,0.45)' },
  actionDangerText: { color: colors.red, fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },

  audit: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 10, marginTop: 6, borderRadius: radii.md, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  auditAction: { color: colors.textPrimary, fontSize: 11.5, fontWeight: '900', letterSpacing: 0.4 },
  auditMeta: { color: colors.textMuted, fontSize: 10, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'] },

  modalCta: { backgroundColor: colors.red, paddingVertical: 14, borderRadius: 999, alignItems: 'center', marginTop: 18 },
  modalCtaText: { color: '#fff', fontSize: 12, fontWeight: '900', letterSpacing: 1 },
});
