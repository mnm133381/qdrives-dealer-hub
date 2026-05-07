/**
 * Q Drives — unauth landing portal.
 *
 * The first screen unauthenticated users see. Presents two clearly-separated
 * entry paths so the role hierarchy is psychologically obvious before login:
 *
 *   1. Dealer Network Access  → cinematic / marketplace styling
 *   2. Q Drives Admin Access  → operational / data styling
 *
 * Both paths converge on the same /(auth)/login screen but with a `role` hint
 * query param. Backend assignment is canonical (ADMIN_PHONES env list); this
 * is purely a UX framing layer — no security implications.
 *
 * Single app, single backend, single auth system.
 */
import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ImageBackground,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowRight, ShieldCheck, Gavel, ChevronRight, Lock, Award, Activity,
  Sparkles, Users, LayoutDashboard, Zap, Eye,
} from 'lucide-react-native';
import { LogoLockupHorizontal } from '../../src/components/Logo';
import { colors, radii } from '../../src/theme';

export default function AuthLanding() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const goDealer = () => router.push({ pathname: '/(auth)/login', params: { role: 'dealer' } });
  const goAdmin = () => router.push({ pathname: '/(auth)/login', params: { role: 'admin' } });

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* Brand header — compact horizontal lockup, institutional feel */}
        <View style={styles.brand}>
          <LogoLockupHorizontal height={34} showSubline />
        </View>

        <Text style={styles.entryHeading}>Choose your access</Text>
        <Text style={styles.entrySub}>Q Drives is a controlled wholesale auction marketplace.{"\n"}Select the entry path that matches your role.</Text>

        {/* DEALER CARD — cinematic, marketplace */}
        <TouchableOpacity activeOpacity={0.92} onPress={goDealer} style={styles.dealerCard} testID="entry-dealer">
          <ImageBackground
            source={{ uri: 'https://images.unsplash.com/photo-1764089859664-30aa6919ef0b?w=1200&q=80' }}
            style={styles.dealerBg}
            imageStyle={{ opacity: 0.20, borderRadius: radii.lg }}
          >
            <View style={styles.dealerOverlay} />
            <View style={styles.cardHead}>
              <View style={styles.dealerBadge}>
                <Gavel size={11} color={colors.red} />
                <Text style={styles.dealerBadgeText}>DEALER NETWORK</Text>
              </View>
              <View style={styles.live}><View style={styles.liveDot} /><Text style={styles.liveText}>LIVE</Text></View>
            </View>
            <Text style={styles.dealerTitle}>Dealer Network Access</Text>
            <Text style={styles.dealerSub}>Bid, buy and watch verified inventory from Q Drives — settled in 48 hours.</Text>

            <View style={styles.featureRow}>
              <Feature icon={<Activity size={12} color={colors.red} />} text="Live bidding" />
              <Feature icon={<Eye size={12} color={colors.red} />} text="Watchlist alerts" />
              <Feature icon={<Award size={12} color={colors.red} />} text="Verified wins" />
            </View>

            <View style={styles.cardCta}>
              <Text style={styles.cardCtaText}>Login or register as dealer</Text>
              <ArrowRight size={16} color="#fff" />
            </View>
          </ImageBackground>
        </TouchableOpacity>

        {/* DIVIDER */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>OR OPERATIONS</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* ADMIN CARD — operational, data */}
        <TouchableOpacity activeOpacity={0.92} onPress={goAdmin} style={styles.adminCard} testID="entry-admin">
          <View style={styles.adminAccentLeft} />
          <View style={styles.cardHead}>
            <View style={styles.adminBadge}>
              <ShieldCheck size={11} color={colors.warning} />
              <Text style={styles.adminBadgeText}>Q DRIVES OPS · RESTRICTED</Text>
            </View>
            <Lock size={14} color={colors.textMuted} />
          </View>
          <Text style={styles.adminTitle}>Admin / Operator Access</Text>
          <Text style={styles.adminSub}>Inventory control, auction operations, dealer approvals, moderation, broadcast notifications and analytics.</Text>

          <View style={styles.adminFeatureGrid}>
            <AdminFeature icon={<LayoutDashboard size={12} color={colors.textChrome} />} label="Operations dashboard" />
            <AdminFeature icon={<Zap size={12} color={colors.textChrome} />} label="Launch auctions" />
            <AdminFeature icon={<Users size={12} color={colors.textChrome} />} label="Dealer approvals" />
            <AdminFeature icon={<Sparkles size={12} color={colors.textChrome} />} label="Moderation tools" />
          </View>

          <View style={styles.adminCardCta}>
            <Text style={styles.adminCardCtaText}>Continue as operator</Text>
            <ChevronRight size={14} color={colors.warning} />
          </View>
        </TouchableOpacity>

        <View style={styles.legalRow}>
          <Text style={styles.legal}>By continuing you agree to Q Drives' dealer terms · privacy · auction policy.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

function Feature({ icon, text }: any) {
  return (
    <View style={styles.feature}>
      {icon}
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

function AdminFeature({ icon, label }: any) {
  return (
    <View style={styles.adminFeat}>
      {icon}
      <Text style={styles.adminFeatText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  brand: { alignItems: 'center', paddingTop: 28, paddingBottom: 8 },
  shield: {
    width: 56, height: 64, backgroundColor: colors.bgCard, borderRadius: 12,
    borderWidth: 1.5, borderColor: colors.red, alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.red, shadowOpacity: 0.4, shadowOffset: { width: 0, height: 0 }, shadowRadius: 18, elevation: 8,
  },
  shieldQ: { color: colors.textPrimary, fontSize: 36, fontWeight: '900', letterSpacing: -2 },
  brandText: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', letterSpacing: 6, marginTop: 12 },
  brandTag: { color: colors.textMuted, fontSize: 11, marginTop: 4, letterSpacing: 1.4, textTransform: 'uppercase' },

  entryHeading: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 22, letterSpacing: -0.4 },
  entrySub: { color: colors.textChrome, fontSize: 12, textAlign: 'center', marginTop: 8, paddingHorizontal: 30, lineHeight: 18 },

  // Dealer card — cinematic
  dealerCard: {
    marginHorizontal: 20, marginTop: 22, borderRadius: radii.lg,
    borderWidth: 1.5, borderColor: colors.red, overflow: 'hidden',
    shadowColor: colors.red, shadowOpacity: 0.35, shadowOffset: { width: 0, height: 6 }, shadowRadius: 18, elevation: 8,
  },
  dealerBg: { padding: 18, minHeight: 230 },
  dealerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(20,8,8,0.7)', borderRadius: radii.lg },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dealerBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.18)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.5)' },
  dealerBadgeText: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(16,185,129,0.4)' },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  liveText: { color: colors.success, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  dealerTitle: { color: '#fff', fontSize: 24, fontWeight: '900', marginTop: 18, letterSpacing: -0.5 },
  dealerSub: { color: 'rgba(255,255,255,0.78)', fontSize: 12, marginTop: 6, lineHeight: 17 },
  featureRow: { flexDirection: 'row', gap: 8, marginTop: 16, flexWrap: 'wrap' },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' },
  featureText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  cardCta: { marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.10)' },
  cardCtaText: { color: '#fff', fontSize: 13, fontWeight: '900', letterSpacing: 0.6 },

  // Divider
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 28, marginHorizontal: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 2 },

  // Admin card — operational
  adminCard: {
    marginHorizontal: 20, marginTop: 18, padding: 18, borderRadius: radii.lg,
    backgroundColor: colors.bgCard, borderWidth: 1, borderColor: 'rgba(245,158,11,0.35)',
    overflow: 'hidden',
  },
  adminAccentLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colors.warning, opacity: 0.5 },
  adminBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(245,158,11,0.10)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)' },
  adminBadgeText: { color: colors.warning, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  adminTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginTop: 12, letterSpacing: -0.3 },
  adminSub: { color: colors.textChrome, fontSize: 11.5, marginTop: 6, lineHeight: 16 },
  adminFeatureGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  adminFeat: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  adminFeatText: { color: colors.textChrome, fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
  adminCardCta: { marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  adminCardCtaText: { color: colors.warning, fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },

  legalRow: { paddingHorizontal: 30, marginTop: 28 },
  legal: { color: colors.textMuted, fontSize: 10, textAlign: 'center', lineHeight: 15 },
});
