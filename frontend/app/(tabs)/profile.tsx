import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, TouchableOpacity } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BadgeCheck, ShieldCheck, TrendingUp, Award, LogOut, Settings, ChevronRight, Star, Bell, FileText, Send } from 'lucide-react-native';
import { colors, radii, formatINR } from '../../src/theme';
import { useAuth } from '../../src/auth';
import { PendingApprovalCard } from '../../src/components/PendingApprovalCard';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';
import { Platform } from 'react-native';
import { registerForPushNotifications } from '../../src/notifications';

export default function Profile() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dealer, signOut } = useAuth();
  const toast = useToast();
  const [stats, setStats] = useState<any>(null);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.dashboard();
      setStats(s);
    } catch {}
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const doSignOut = async () => {
    if (!confirmingSignOut) {
      setConfirmingSignOut(true);
      toast.show('Tap sign out again to confirm', 'info');
      setTimeout(() => setConfirmingSignOut(false), 3000);
      return;
    }
    await signOut();
    router.replace('/(auth)/login');
  };

  const sendTestPush = async () => {
    if (Platform.OS === 'web') {
      toast.show('Push notifications only work on mobile devices', 'info');
      return;
    }
    try {
      const token = await registerForPushNotifications();
      if (!token) {
        toast.show('Allow notifications in settings to test', 'error');
        return;
      }
      await api.testPush('Q Drives', 'Test alert — your device is reachable.');
      toast.show('Test notification sent — check your device', 'success');
    } catch {
      toast.show('Could not send test notification', 'error');
    }
  };

  if (!dealer) return null;
  const isAdmin = ['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(dealer.role as any);
  return (
    <View style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={styles.cover}>
          <View style={styles.coverGradient} />
          <View style={styles.profileRow}>
            <Image source={{ uri: dealer.avatar_url || 'https://images.unsplash.com/photo-1554765345-6ad6a5417cde?w=300&q=80' }} style={styles.avatar} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <View style={styles.nameRow}>
                <Text style={styles.name} numberOfLines={1}>{dealer.dealership_name || dealer.full_name}</Text>
                {dealer.verified && <BadgeCheck size={18} color={colors.success} />}
              </View>
              <Text style={styles.dealerInfo}>{dealer.full_name} · {dealer.city}</Text>
              {isAdmin && (
                <View style={styles.adminBadge}>
                  <ShieldCheck size={11} color={colors.red} />
                  <Text style={styles.adminBadgeText}>Q DRIVES ADMIN</Text>
                </View>
              )}
              <View style={styles.starRow}>
                <Star size={12} color={colors.warning} fill={colors.warning} />
                <Text style={styles.rating}>{(dealer.trust_score || 4.5).toFixed(1)}</Text>
                <Text style={styles.ratingMuted}>· {dealer.total_purchases} deals</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.statsGrid}>
          <Stat label="Trust Score" value={`${(stats?.trust_score ?? dealer.trust_score ?? 4.5).toFixed(1)}/5`} icon={<ShieldCheck size={16} color={colors.success} />} />
          <Stat label="Bid Success" value={`${stats?.bid_success_rate ?? dealer.bid_success_rate ?? 0}%`} icon={<TrendingUp size={16} color={colors.warning} />} />
          <Stat label="Total Deals" value={`${dealer.total_purchases}`} icon={<Award size={16} color={colors.silver} />} />
        </View>

        {/* Pending / suspended state — operator-side gating surface */}
        {!isAdmin && <PendingApprovalCard status={dealer.status} />}

        <View style={styles.statsRow}>
          <BigStat label="LIVE BIDS" value={`${stats?.your_bids ?? 0}`} />
          <BigStat label="WINS" value={`${stats?.your_wins ?? 0}`} />
          {isAdmin
            ? <BigStat label="INVENTORY" value={`${dealer.total_listed}`} />
            : <BigStat label="WATCHING" value={`${stats?.watching ?? 0}`} />}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <Row label="Role" value={isAdmin ? 'Q Drives Admin' : 'Dealer'} valueColor={isAdmin ? colors.red : colors.textPrimary} />
          {!isAdmin && (
            <Row
              label="Account status"
              value={
                dealer.status === 'approved' ? 'Approved' :
                dealer.status === 'pending' ? 'Pending approval' :
                dealer.status === 'suspended' ? 'Suspended' :
                dealer.status === 'revoked' ? 'Revoked' : '—'
              }
              valueColor={
                dealer.status === 'approved' ? colors.success :
                dealer.status === 'pending' ? colors.warning :
                colors.red
              }
            />
          )}
          <Row label="Verification" value={dealer.kyc_completed ? 'Verified' : 'Pending'} valueColor={dealer.kyc_completed ? colors.success : colors.warning} />
          <Row label="Phone" value={dealer.phone} />
          <Row label="GST" value={(dealer as any).gst_number || 'Not provided'} />
          <Row label="PAN" value={(dealer as any).pan_number || 'Not provided'} />
        </View>

        {isAdmin && (
          <TouchableOpacity onPress={() => router.push('/my-listings')} style={styles.menuItem} testID="profile-my-listings">
            <FileText size={18} color={colors.textChrome} />
            <Text style={styles.menuText}>Manage inventory & inspection PDFs</Text>
            <ChevronRight size={16} color={colors.textMuted} />
          </TouchableOpacity>
        )}

        <TouchableOpacity onPress={() => router.push('/notifications')} style={[styles.menuItem, { marginTop: 8 }]} testID="profile-notifications">
          <Bell size={18} color={colors.textChrome} />
          <Text style={styles.menuText}>Notifications & alerts</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity onPress={sendTestPush} style={[styles.menuItem, { marginTop: 8 }]} testID="profile-test-push">
          <Send size={18} color={colors.textChrome} />
          <Text style={styles.menuText}>Send test push notification</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.push('/(tabs)/watchlist')} style={[styles.menuItem, { marginTop: 8 }]} testID="profile-watchlist">
          <Settings size={18} color={colors.textChrome} />
          <Text style={styles.menuText}>My watchlist</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </TouchableOpacity>

        <TouchableOpacity onPress={doSignOut} style={[styles.menuItem, { marginTop: 8 }, confirmingSignOut && styles.menuItemDanger]} testID="profile-signout">
          <LogOut size={18} color={colors.red} />
          <Text style={[styles.menuText, { color: colors.red }]}>{confirmingSignOut ? 'Tap again to confirm' : 'Sign out'}</Text>
          <View style={{ width: 16 }} />
        </TouchableOpacity>

        <Text style={styles.footer}>Q DRIVES · v1.0.0</Text>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, icon }: any) {
  return (
    <View style={styles.statCard}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {icon}
        <Text style={styles.statLabel}>{label}</Text>
      </View>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}
function BigStat({ label, value }: any) {
  return (
    <View style={styles.bigStat}>
      <Text style={styles.bigStatVal}>{value}</Text>
      <Text style={styles.bigStatLabel}>{label}</Text>
    </View>
  );
}
function Row({ label, value, valueColor }: any) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  cover: { paddingHorizontal: 20, paddingVertical: 24, backgroundColor: colors.bgCard, borderBottomColor: colors.border, borderBottomWidth: 1 },
  coverGradient: { position: 'absolute', top: 0, left: 0, right: 0, height: 80, backgroundColor: 'rgba(185,28,28,0.04)' },
  profileRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 70, height: 70, borderRadius: 35, borderWidth: 2, borderColor: colors.red },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  dealerInfo: { color: colors.textSecondary, fontSize: 12, marginTop: 4 },
  starRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  rating: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  ratingMuted: { color: colors.textMuted, fontSize: 12 },
  adminBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)', borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start', marginTop: 6 },
  adminBadgeText: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },

  statsGrid: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 20 },
  statCard: { flex: 1, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 12 },
  statLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  statValue: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },

  statsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 12 },
  bigStat: { flex: 1, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 14, alignItems: 'center' },
  bigStatVal: { color: colors.textPrimary, fontSize: 22, fontWeight: '800' },
  bigStatLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.2, marginTop: 4 },

  section: { paddingHorizontal: 20, marginTop: 28 },
  sectionTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 0.4, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  rowLabel: { color: colors.textSecondary, fontSize: 13 },
  rowValue: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },

  menuItem: {
    marginHorizontal: 20, marginTop: 16,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, paddingVertical: 14, paddingHorizontal: 16,
  },
  menuItemDanger: { borderColor: 'rgba(185,28,28,0.5)', backgroundColor: 'rgba(185,28,28,0.06)' },
  menuText: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: '600' },

  footer: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: 32, letterSpacing: 2 },
});
