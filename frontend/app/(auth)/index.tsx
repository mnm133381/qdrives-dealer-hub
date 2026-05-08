/**
 * Q Drives — Marketplace entry portal.
 *
 * Premium institutional onboarding: dealer card is the visual hero
 * (commercial), operator card is restrained (operational). Reference mood:
 * Bloomberg Terminal × Porsche configurator × enterprise trading desk.
 *
 * Both paths route to /(auth)/login with a `role` query — backend assignment
 * is canonical (ADMIN_PHONES env list), so this is purely UX framing.
 */
import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, ImageBackground,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowRight, ShieldCheck, ChevronRight, Lock, Activity,
  Users, LayoutDashboard, Zap, Sparkles, BadgeCheck,
} from 'lucide-react-native';
import { LogoLockupHorizontal } from '../../src/components/Logo';
import { colors, radii } from '../../src/theme';

export default function AuthLanding() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const goDealer = () => router.push({ pathname: '/(auth)/login', params: { role: 'dealer' } });
  const goAdmin = () => router.push({ pathname: '/(auth)/login', params: { role: 'admin' } });
  const goSeller = () => router.push('/(seller)/login' as any);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 36 }} showsVerticalScrollIndicator={false}>
        {/* Brand block — 15% larger, tighter to headline */}
        <View style={styles.brand}>
          <LogoLockupHorizontal height={40} showSubline />
        </View>

        {/* Headline — institutional authority */}
        <Text style={styles.heading}>ENTER THE MARKETPLACE</Text>
        <Text style={styles.sub}>Verified wholesale auction access for serious dealers.</Text>

        {/* DEALER CARD — visual hero */}
        <TouchableOpacity activeOpacity={0.94} onPress={goDealer} style={styles.dealerCard} testID="entry-dealer">
          <ImageBackground
            source={{ uri: 'https://images.unsplash.com/photo-1485291571150-772bcfc10da5?crop=entropy&cs=srgb&fm=jpg&w=1200&q=80' }}
            style={styles.dealerBg}
            imageStyle={{ opacity: 0.22, borderRadius: radii.lg }}
            blurRadius={6}
          >
            {/* Dual overlay: dark base + soft red wash (reduced 25%) */}
            <View style={styles.dealerOverlayDark} />
            <View style={styles.dealerOverlayRed} />

            <View style={styles.cardHead}>
              <View style={styles.dealerBadge}>
                <BadgeCheck size={11} color={colors.red} strokeWidth={2.4} />
                <Text style={styles.dealerBadgeText}>DEALER NETWORK</Text>
              </View>
              <View style={styles.live}>
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>LIVE</Text>
              </View>
            </View>

            <Text style={styles.dealerTitle}>Dealer Network Access</Text>
            <Text style={styles.dealerSub}>
              Bid, buy and watch verified inventory from Q Drives. Settled in 48 hours.
            </Text>

            <View style={styles.featureRow}>
              <Feature icon={<Activity size={11} color={colors.red} strokeWidth={2.4} />} text="LIVE BIDDING" />
              <Feature icon={<BadgeCheck size={11} color={colors.red} strokeWidth={2.4} />} text="VERIFIED INVENTORY" />
            </View>

            <View style={styles.cardCta}>
              <Text style={styles.cardCtaText}>Login or register as dealer</Text>
              <View style={styles.cardCtaArrow}>
                <ArrowRight size={14} color="#fff" strokeWidth={2.4} />
              </View>
            </View>
          </ImageBackground>
        </TouchableOpacity>

        {/* DIVIDER */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>OR OPERATIONS</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* ADMIN CARD — operational, restrained */}
        <TouchableOpacity activeOpacity={0.92} onPress={goAdmin} style={styles.adminCard} testID="entry-admin">
          <View style={styles.adminAccentLeft} />
          <View style={styles.cardHead}>
            <View style={styles.adminBadge}>
              <ShieldCheck size={10} color={colors.warning} strokeWidth={2.2} />
              <Text style={styles.adminBadgeText}>Q DRIVES OPS · RESTRICTED</Text>
            </View>
            <Lock size={13} color={colors.textMuted} strokeWidth={2} />
          </View>

          <Text style={styles.adminTitle}>Admin / Operator Access</Text>
          <Text style={styles.adminSub}>
            Inventory control, auction operations, dealer approvals, moderation, broadcast and analytics.
          </Text>

          <View style={styles.adminFeatureGrid}>
            <AdminFeature icon={<LayoutDashboard size={11} color={colors.textChrome} />} label="Operations dashboard" />
            <AdminFeature icon={<Zap size={11} color={colors.textChrome} />} label="Launch auctions" />
            <AdminFeature icon={<Users size={11} color={colors.textChrome} />} label="Dealer approvals" />
            <AdminFeature icon={<Sparkles size={11} color={colors.textChrome} />} label="Moderation tools" />
          </View>

          <View style={styles.adminCardCta}>
            <Text style={styles.adminCardCtaText}>Continue as operator</Text>
            <ChevronRight size={13} color={colors.warning} strokeWidth={2.2} />
          </View>
        </TouchableOpacity>

        {/* Seller (vehicle owner) — read-only access path */}
        <TouchableOpacity activeOpacity={0.92} onPress={goSeller} style={styles.sellerCard} testID="entry-seller">
          <View style={styles.sellerLeft}>
            <View style={styles.sellerIcon}>
              <ShieldCheck size={14} color={colors.silver} strokeWidth={2.2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sellerTitle}>I sold my car to Q Drives</Text>
              <Text style={styles.sellerSub}>Track your vehicle on the auction floor · read-only</Text>
            </View>
          </View>
          <ChevronRight size={14} color={colors.textChrome} strokeWidth={2.2} />
        </TouchableOpacity>

        {/* Legal — quiet, low opacity */}
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

  // Brand block — slightly larger logo, tightened spacing
  brand: { alignItems: 'center', paddingTop: 32, paddingBottom: 6 },

  // Hierarchy: bold premium headline + thin one-line sub
  heading: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: 22,
    letterSpacing: 1.2,
  },
  sub: {
    color: colors.silver,
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 32,
    letterSpacing: 0.4,
  },

  // Dealer card — visual hero
  dealerCard: {
    marginHorizontal: 18,
    marginTop: 26,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.red,
    overflow: 'hidden',
    // Restrained ambient red glow — much softer than before
    shadowColor: colors.red,
    shadowOpacity: 0.22,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 14,
    elevation: 6,
  },
  dealerBg: {
    padding: 22,
    minHeight: 264,
  },
  // Dark base — black wash to push the silhouette deeper
  dealerOverlayDark: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(5,5,5,0.62)',
    borderRadius: radii.lg,
  },
  // Reduced red wash — was rgba(20,8,8,0.7), now significantly lighter
  dealerOverlayRed: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(212,20,30,0.10)',
    borderRadius: radii.lg,
  },

  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  dealerBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(212,20,30,0.12)',
    borderWidth: 1, borderColor: 'rgba(212,20,30,0.45)',
  },
  dealerBadgeText: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },

  live: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1, borderColor: 'rgba(16,185,129,0.40)',
    backgroundColor: 'rgba(16,185,129,0.06)',
  },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.success },
  liveText: { color: colors.success, fontSize: 9, fontWeight: '900', letterSpacing: 1 },

  dealerTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '900',
    marginTop: 26,
    letterSpacing: -0.6,
  },
  dealerSub: {
    color: 'rgba(245,247,250,0.74)',
    fontSize: 12.5,
    fontWeight: '400',
    marginTop: 8,
    lineHeight: 18,
    maxWidth: 340,
  },

  // Feature chips — only 2 now, cleaner spacing, lower glow
  featureRow: { flexDirection: 'row', gap: 8, marginTop: 20, flexWrap: 'wrap' },
  feature: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  featureText: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '800', letterSpacing: 1 },

  cardCta: {
    marginTop: 22, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 14, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)',
  },
  cardCtaText: { color: '#FFFFFF', fontSize: 13, fontWeight: '900', letterSpacing: 0.4 },
  cardCtaArrow: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(212,20,30,0.85)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Divider
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 28, marginHorizontal: 22 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 2.2 },

  // Admin card — restrained
  adminCard: {
    marginHorizontal: 18,
    marginTop: 18,
    padding: 18,
    borderRadius: radii.lg,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.22)',  // ↓~12% from 0.35
    overflow: 'hidden',
  },
  adminAccentLeft: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    width: 2,
    backgroundColor: colors.warning,
    opacity: 0.42,
  },
  adminBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.32)',
  },
  adminBadgeText: { color: colors.warning, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  adminTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '800', marginTop: 14, letterSpacing: -0.3 },
  adminSub: { color: colors.textChrome, fontSize: 11.5, fontWeight: '400', marginTop: 6, lineHeight: 16 },

  adminFeatureGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 14 },
  adminFeat: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 6,
    borderRadius: 6, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  adminFeatText: { color: colors.textChrome, fontSize: 10, fontWeight: '600', letterSpacing: 0.2 },

  adminCardCta: {
    marginTop: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border,
  },
  adminCardCtaText: { color: colors.warning, fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },

  // Legal — much quieter
  legalRow: { paddingHorizontal: 32, marginTop: 32 },
  legal: {
    color: colors.textMuted,
    opacity: 0.55,
    fontSize: 10,
    fontWeight: '400',
    textAlign: 'center',
    lineHeight: 15,
    letterSpacing: 0.2,
  },

  // Seller (vehicle owner) — restrained pill row
  sellerCard: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 18, marginTop: 14,
    padding: 14, borderRadius: radii.md,
    backgroundColor: colors.bgCard,
    borderWidth: 1, borderColor: colors.border,
  },
  sellerLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  sellerIcon: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bgDeep, borderWidth: 1, borderColor: colors.border,
  },
  sellerTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '800', letterSpacing: -0.1 },
  sellerSub: { color: colors.textChrome, fontSize: 11, fontWeight: '500', marginTop: 2 },
});
