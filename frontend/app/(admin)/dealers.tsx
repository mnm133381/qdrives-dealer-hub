import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, TextInput, Image, Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Search, BadgeCheck, Ban, ShieldCheck, Phone, Building2, MapPin, AlertTriangle } from 'lucide-react-native';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';
import { AdminHeader } from '../../src/components/AdminHeader';

type Filter = 'all' | 'pending' | 'verified' | 'suspended';

export default function AdminDealers() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (q) params.q = q;
      if (filter !== 'all') params.status_filter = filter;
      const list = await api.adminDealers(params);
      setItems(list as any[]);
    } catch (e: any) { toast.show(e.message || 'Could not load dealers', 'error'); }
    finally { setLoading(false); }
  }, [q, filter]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const verify = async (id: string) => {
    setBusyId(id);
    try { await api.adminVerifyDealer(id, { verified: true }); toast.show('Dealer verified · push sent', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusyId(null); }
  };
  const suspend = async (id: string) => {
    Alert.alert('Suspend dealer?', 'Account will lose bidding access immediately.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Suspend', style: 'destructive', onPress: async () => {
        setBusyId(id);
        try { await api.adminVerifyDealer(id, { suspended: true }); toast.show('Dealer suspended', 'success'); load(); }
        catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
        finally { setBusyId(null); }
      }}]);
  };
  const reinstate = async (id: string) => {
    setBusyId(id);
    try { await api.adminVerifyDealer(id, { suspended: false }); toast.show('Dealer reinstated', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    finally { setBusyId(null); }
  };

  return (
    <View style={styles.root}>
      <AdminHeader kicker="Dealer network" title="Approvals & moderation" sub="Approve new dealers, suspend bad actors, audit performance." />
      <View style={styles.toolBar}>
        <View style={styles.searchBox}>
          <Search size={14} color={colors.textMuted} />
          <TextInput
            value={q} onChangeText={setQ} placeholder="Search by name, phone, city"
            placeholderTextColor={colors.textMuted} style={styles.searchInput}
            autoCapitalize="none"
            onSubmitEditing={load}
            returnKeyType="search"
          />
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {(['all', 'pending', 'verified', 'suspended'] as Filter[]).map((f) => (
          <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.filterPill, filter === f && styles.filterPillActive]}>
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>{f.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, paddingBottom: 60 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}>
        {loading && items.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}><ActivityIndicator color={colors.red} /></View>
        ) : items.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>No dealers in this view.</Text></View>
        ) : items.map((d) => (
          <View key={d.id} style={styles.card}>
            <View style={styles.cardHead}>
              <Image source={{ uri: d.avatar_url || 'https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=160&q=80' }} style={styles.avatar} />
              <View style={{ flex: 1 }}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>{d.dealership_name || d.full_name || 'Unnamed'}</Text>
                  {d.suspended ? (
                    <View style={[styles.statusPill, styles.statusSuspended]}><Ban size={9} color={colors.red} /><Text style={[styles.statusText, { color: colors.red }]}>SUSPENDED</Text></View>
                  ) : d.verified ? (
                    <View style={[styles.statusPill, styles.statusOk]}><BadgeCheck size={9} color={colors.success} /><Text style={[styles.statusText, { color: colors.success }]}>VERIFIED</Text></View>
                  ) : (
                    <View style={[styles.statusPill, styles.statusPending]}><AlertTriangle size={9} color={colors.warning} /><Text style={[styles.statusText, { color: colors.warning }]}>PENDING</Text></View>
                  )}
                </View>
                <View style={styles.metaRow}><Phone size={10} color={colors.textMuted} /><Text style={styles.metaText}>{d.phone}</Text></View>
                <View style={styles.metaRow}><MapPin size={10} color={colors.textMuted} /><Text style={styles.metaText}>{d.city || 'Unknown city'}</Text></View>
                {d.full_name && <Text style={styles.fullName}>{d.full_name}</Text>}
              </View>
            </View>
            <View style={styles.statsRow}>
              <Stat label="BIDS" value={`${d.bids_count || 0}`} />
              <Stat label="WINS" value={`${d.wins_count || 0}`} />
              <Stat label="TRUST" value={`${(d.trust_score || 0).toFixed(1)}★`} />
            </View>
            <View style={styles.actions}>
              {!d.verified && !d.suspended && (
                <TouchableOpacity disabled={busyId === d.id} onPress={() => verify(d.id)} style={[styles.actionBtn, styles.actionApprove]}>
                  <ShieldCheck size={12} color={colors.success} />
                  <Text style={[styles.actionText, { color: colors.success }]}>{busyId === d.id ? 'Approving…' : 'Approve'}</Text>
                </TouchableOpacity>
              )}
              {!d.suspended && d.verified && (
                <TouchableOpacity disabled={busyId === d.id} onPress={() => suspend(d.id)} style={[styles.actionBtn, styles.actionDanger]}>
                  <Ban size={12} color={colors.red} />
                  <Text style={[styles.actionText, { color: colors.red }]}>Suspend</Text>
                </TouchableOpacity>
              )}
              {d.suspended && (
                <TouchableOpacity disabled={busyId === d.id} onPress={() => reinstate(d.id)} style={[styles.actionBtn, styles.actionApprove]}>
                  <ShieldCheck size={12} color={colors.success} />
                  <Text style={[styles.actionText, { color: colors.success }]}>Reinstate</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
function Stat({ label, value }: any) { return <View style={styles.stat}><Text style={styles.statLabel}>{label}</Text><Text style={styles.statValue}>{value}</Text></View>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  toolBar: { paddingHorizontal: 20, paddingTop: 12 },
  searchBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: 12, paddingVertical: 10 },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  filterRow: { gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  filterPill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 },
  filterPillActive: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: colors.red },
  filterText: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  filterTextActive: { color: colors.red },
  empty: { paddingVertical: 60, alignItems: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 13 },
  card: { padding: 14, borderRadius: radii.lg, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, marginBottom: 12 },
  cardHead: { flexDirection: 'row', gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#000' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  name: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2, flex: 1 },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  statusOk: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  statusPending: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' },
  statusSuspended: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  statusText: { fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  metaText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  fullName: { color: colors.textChrome, fontSize: 11, marginTop: 4 },
  statsRow: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  stat: { flex: 1 },
  statLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  statValue: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1 },
  actionApprove: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  actionDanger: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  actionText: { fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },
});
