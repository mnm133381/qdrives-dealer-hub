/**
 * Seller home — list of linked vehicles. Read-only.
 *
 * Each row routes to /(seller)/vehicle/[id] for the full tracking page.
 * Pulls /api/seller/vehicles which is sanitized server-side (no dealer
 * identities, no marketplace data).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronRight, LogOut, ShieldCheck, Activity, Car, Clock, CheckCircle2,
} from 'lucide-react-native';
import { LogoMark } from '../../src/components/Logo';
import { colors, radii, formatINR } from '../../src/theme';
import { api, TOKEN_KEY } from '../../src/api';
import { storage } from '../../src/storage';
import { useToast } from '../../src/toast';

const AUCTION_STATE_LABEL: Record<string, string> = {
  scheduled: 'SCHEDULED',
  live: 'LIVE',
  ended: 'AUCTION CLOSED',
  ended_pending_payment: 'PENDING SETTLEMENT',
  payment_received: 'PAYMENT RECEIVED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
};

const SETT_LABEL: Record<string, string> = {
  awaiting_operator_review: 'INTAKE',
  deposit_requested: 'DEPOSIT REQUESTED',
  deposit_under_verification: 'VERIFYING DEPOSIT',
  deposit_verified: 'DEPOSIT VERIFIED',
  visit_scheduled: 'VISIT SCHEDULED',
  inspection_completed: 'INSPECTION DONE',
  full_payment_requested: 'FINAL PAYMENT',
  full_payment_received: 'PAYMENT RECEIVED',
  vehicle_delivered: 'DELIVERED',
  completed: 'COMPLETED',
  refund_completed: 'REFUNDED',
};

export default function SellerHome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [me, setMe] = useState<any | null>(null);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, v] = await Promise.all([api.sellerMe(), api.sellerVehicles()]);
      setMe(m); setVehicles(v || []);
    } catch (e: any) {
      if ((e.message || '').includes('401') || (e.message || '').toLowerCase().includes('not authenticated')) {
        router.replace('/(seller)/login' as any);
      } else {
        toast.show(e.message || 'Failed to load', 'error');
      }
    } finally { setLoading(false); }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const logout = async () => {
    await storage.removeItem(TOKEN_KEY);
    router.replace('/(auth)' as any);
  };

  if (loading || !me) {
    return <View style={styles.loadWrap}><ActivityIndicator color={colors.red} /></View>;
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headRow}>
          <LogoMark size={26} />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.kicker}>OWNER PORTAL</Text>
            <Text style={styles.welcome} numberOfLines={1}>{me.name || 'Welcome'}</Text>
          </View>
          <TouchableOpacity onPress={logout} style={styles.logoutBtn} testID="seller-logout">
            <LogOut size={14} color={colors.textChrome} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        <View style={styles.trustCard}>
          <ShieldCheck size={14} color={colors.success} />
          <Text style={styles.trustText}>
            You’re viewing a <Text style={{ color: colors.textPrimary, fontWeight: '900' }}>read-only</Text> tracking layer. Q Drives operations control all auction actions.
          </Text>
        </View>

        <Text style={styles.sectionLabel}>YOUR VEHICLES · {vehicles.length}</Text>

        {vehicles.length === 0 ? (
          <View style={styles.empty}>
            <Car size={20} color={colors.textChrome} />
            <Text style={styles.emptyTitle}>No vehicle linked yet</Text>
            <Text style={styles.emptyBody}>The Q Drives team will link your vehicle to your access shortly.</Text>
          </View>
        ) : (
          vehicles.map((v: any) => {
            const a = v.auction || {};
            const isLive = a.status === 'live';
            return (
              <TouchableOpacity
                key={v.vehicle_id} activeOpacity={0.92}
                onPress={() => router.push(`/(seller)/vehicle/${v.vehicle_id}` as any)}
                style={styles.row}
                testID={`seller-vehicle-${v.vehicle_id}`}
              >
                <Image source={{ uri: v.image || '' }} style={styles.thumb} />
                <View style={{ flex: 1, padding: 12 }}>
                  <View style={styles.rowHead}>
                    <View style={[styles.statusPill, isLive && styles.statusPillLive]}>
                      {isLive && <View style={styles.liveDot} />}
                      <Text style={[styles.statusText, isLive && { color: colors.red }]}>
                        {AUCTION_STATE_LABEL[a.status] || (a.status || '').toUpperCase()}
                      </Text>
                    </View>
                    {v.settlement_state && (
                      <View style={styles.settPill}>
                        <CheckCircle2 size={9} color={colors.success} />
                        <Text style={styles.settPillText}>{SETT_LABEL[v.settlement_state] || v.settlement_state.toUpperCase()}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.title} numberOfLines={1}>{v.year} {v.make} {v.model}</Text>
                  <Text style={styles.sub} numberOfLines={1}>{v.registration_number || '—'} · {v.variant || ''}</Text>
                  <View style={styles.metricRow}>
                    <View style={styles.metricCell}>
                      <Text style={styles.metricLabel}>CURRENT BID</Text>
                      <Text style={styles.metricVal}>{formatINR(a.current_bid || 0)}</Text>
                    </View>
                    <View style={styles.metricCell}>
                      <Text style={styles.metricLabel}>BIDDERS</Text>
                      <Text style={styles.metricVal}>{a.active_bidder_count || 0}</Text>
                    </View>
                    <ChevronRight size={16} color={colors.textMuted} />
                  </View>
                </View>
              </TouchableOpacity>
            );
          })
        )}

        <View style={styles.note}>
          <Activity size={11} color={colors.textMuted} />
          <Text style={styles.noteText}>Updates appear live. Pull-to-refresh for latest.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loadWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },

  header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgDeep },
  headRow: { flexDirection: 'row', alignItems: 'center' },
  kicker: { color: colors.silver, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  welcome: { color: colors.textPrimary, fontSize: 16, fontWeight: '900', marginTop: 2, letterSpacing: -0.3 },
  logoutBtn: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },

  trustCard: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: radii.md, backgroundColor: 'rgba(0,208,132,0.06)', borderWidth: 1, borderColor: 'rgba(0,208,132,0.30)', marginBottom: 16 },
  trustText: { color: colors.textChrome, fontSize: 12, fontWeight: '500', flex: 1, lineHeight: 17 },

  sectionLabel: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4, marginBottom: 10 },

  empty: { padding: 22, alignItems: 'center', borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  emptyTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', marginTop: 10 },
  emptyBody: { color: colors.textChrome, fontSize: 12, fontWeight: '500', textAlign: 'center', marginTop: 4, lineHeight: 17, opacity: 0.85 },

  row: { flexDirection: 'row', backgroundColor: colors.bgCard, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, marginBottom: 12, overflow: 'hidden' },
  thumb: { width: 110, height: 110, backgroundColor: '#000' },
  rowHead: { flexDirection: 'row', gap: 6, marginBottom: 6, alignItems: 'center' },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.bgDeep, borderWidth: 1, borderColor: colors.border },
  statusPillLive: { backgroundColor: 'rgba(255,30,45,0.10)', borderColor: 'rgba(255,30,45,0.45)' },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.red },
  statusText: { color: colors.textChrome, fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },
  settPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.successBg, borderWidth: 1, borderColor: 'rgba(0,208,132,0.30)' },
  settPillText: { color: colors.success, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.8 },
  title: { color: colors.textPrimary, fontSize: 13, fontWeight: '900', letterSpacing: -0.2 },
  sub: { color: colors.textChrome, fontSize: 10.5, fontWeight: '500', marginTop: 2 },
  metricRow: { flexDirection: 'row', gap: 12, marginTop: 10, alignItems: 'center' },
  metricCell: { flexDirection: 'column' },
  metricLabel: { color: colors.textMuted, fontSize: 8.5, fontWeight: '900', letterSpacing: 0.8 },
  metricVal: { color: colors.textPrimary, fontSize: 13, fontWeight: '900', marginTop: 2, fontVariant: ['tabular-nums'], letterSpacing: -0.2 },

  note: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 12, justifyContent: 'center' },
  noteText: { color: colors.textMuted, fontSize: 10.5, fontWeight: '500' },
});
