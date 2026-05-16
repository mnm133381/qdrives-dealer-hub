/**
 * Login screen — strict role-isolated.
 *
 * Driven by the `role` query param set on the unauth landing portal:
 *   • role=dealer  → calls /auth/dealer/send-otp (approved_dealers allow-list)
 *   • role=admin   → calls /auth/operator/send-otp (operators allow-list)
 *
 * No generic auth route. No auto-downgrade. A phone outside the relevant
 * allow-list never proceeds to OTP entry — instead it lands on a premium
 * inline access-restricted card.
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, ImageBackground,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  ChevronRight, ShieldCheck, Zap, TrendingUp, ArrowLeft, Lock,
  ShieldAlert, Mail,
} from 'lucide-react-native';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { LogoLockupHorizontal } from '../../src/components/Logo';
import phoneAuth, { PhoneAuthError } from '../../src/firebase/phoneAuth';
import { setPendingOtpHandle } from '../../src/firebase/handleStore';

type AccessError = {
  title: string;
  body: string;
  hint: string;
} | null;

export default function Login() {
  const router = useRouter();
  const params = useLocalSearchParams<{ role?: string }>();
  const isAdmin = params.role === 'admin';
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [accessError, setAccessError] = useState<AccessError>(null);

  const heroSrc = useMemo(() => isAdmin
    ? 'https://images.unsplash.com/photo-1551434678-e076c223a692?w=1400&q=85'  // ops dashboards
    : 'https://images.unsplash.com/photo-1761229170508-f4791c297af8?w=1400&q=85',
  [isAdmin]);

  const onSend = async () => {
    setAccessError(null);
    const cleaned = phone.replace(/\s/g, '');
    if (cleaned.length < 10) {
      Alert.alert('Invalid phone', 'Please enter a valid 10-digit mobile number.');
      return;
    }
    const e164 = cleaned.startsWith('+') ? cleaned : `+91${cleaned}`;
    setLoading(true);
    try {
      // (1) Backend role gate — operator allow-list / dealer-vs-operator
      // confusion / rate limit. This must succeed BEFORE we burn an SMS.
      if (isAdmin) {
        await api.operatorSendOtp(e164);
      } else {
        await api.dealerSendOtp(e164);
      }
      // (2) Dispatch the actual SMS via Firebase Phone Auth and stash
      // the confirmation handle so /verify can finalise the code.
      const handle = await phoneAuth.sendOtp(e164);
      setPendingOtpHandle(e164, handle);
      router.push({
        pathname: '/(auth)/verify',
        params: { phone: e164, role: isAdmin ? 'admin' : 'dealer' },
      });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('OPERATOR_ACCESS_DENIED')) {
        setAccessError({
          title: 'Operator access denied.',
          body: 'This number is not authorised for Q Drives operations.',
          hint: 'Operator access is restricted and audited.',
        });
      } else if (msg.includes('USE_OPERATOR_LOGIN')) {
        setAccessError({
          title: 'Use operator sign-in.',
          body: 'This number is registered for operator access. Switch to the operator portal.',
          hint: 'Tap "Choose access" above.',
        });
      } else if (e instanceof PhoneAuthError) {
        Alert.alert('Could not send OTP', e.message);
      } else {
        Alert.alert('Failed to send OTP', msg || 'Try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <ImageBackground
        source={{ uri: heroSrc }}
        style={styles.hero}
        imageStyle={{ opacity: isAdmin ? 0.18 : 0.40 }}
      >
        <View style={[styles.heroOverlay, isAdmin && styles.heroOverlayAdmin]} />
        <View style={styles.heroVignette} />

        {/* Back to portal */}
        <TouchableOpacity onPress={() => router.replace('/(auth)' as any)} style={styles.backChip} testID="login-back-portal">
          <ArrowLeft size={14} color="#fff" />
          <Text style={styles.backChipText}>Choose access</Text>
        </TouchableOpacity>

        <View style={styles.heroContent}>
          <View style={styles.brandRow}>
            <LogoLockupHorizontal height={26} />
            <View style={[styles.brandPill, isAdmin && styles.brandPillAdmin]}>
              {isAdmin && <Lock size={9} color={colors.warning} />}
              <Text style={[styles.brandPillText, isAdmin && styles.brandPillTextAdmin]}>
                {isAdmin ? 'OPERATOR CONSOLE' : 'BUYER NETWORK'}
              </Text>
            </View>
          </View>
          <Text style={styles.heroTitle}>
            {isAdmin ? 'Operator access\nto the auction floor.' : 'The trading floor\nfor serious buyers.'}
          </Text>
          <Text style={styles.heroSub}>
            {isAdmin
              ? 'Inventory · Auction control · Approvals · Settlements'
              : 'Live auctions · Verified inventory · Inspection-grade lots'}
          </Text>
        </View>
      </ImageBackground>

      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <View style={styles.sheetHandle} />
        <Text style={styles.title} testID={isAdmin ? 'login-operator-title' : 'login-dealer-title'}>
          {isAdmin ? 'Operator sign-in' : 'Buyer sign-in'}
        </Text>
        <Text style={styles.subtitle}>
          {isAdmin
            ? 'Restricted to authorised Q Drives operators. Your number is checked against the operator allow-list.'
            : 'Buyer access available upon mobile verification. Bidding activates after Q Drives approves your account.'}
        </Text>

        <View style={styles.inputWrap}>
          <Text style={styles.cc}>+91</Text>
          <View style={styles.divider} />
          <TextInput
            testID="login-phone-input"
            placeholder="Mobile number"
            placeholderTextColor={colors.textMuted}
            keyboardType="phone-pad"
            maxLength={10}
            value={phone}
            onChangeText={(v) => { setPhone(v); if (accessError) setAccessError(null); }}
            style={styles.input}
          />
        </View>

        <TouchableOpacity
          testID="login-send-otp-button"
          activeOpacity={0.9}
          style={[styles.cta, isAdmin && styles.ctaAdmin, (!phone || loading) && styles.ctaDisabled]}
          onPress={onSend}
          disabled={!phone || loading}
        >
          <Text style={styles.ctaText}>{loading ? 'Verifying access...' : isAdmin ? 'Continue as operator' : 'Send OTP'}</Text>
          <ChevronRight size={20} color="#fff" />
        </TouchableOpacity>

        {/* Premium access-restricted state */}
        {accessError && (
          <View style={styles.errorCard} testID="login-access-error">
            <View style={styles.errorIconWrap}>
              <ShieldAlert size={22} color={colors.red} />
            </View>
            <Text style={styles.errorTitle}>{accessError.title}</Text>
            <Text style={styles.errorBody}>{accessError.body}</Text>
            <Text style={styles.errorHint}>{accessError.hint}</Text>
            {!isAdmin && (
              <TouchableOpacity style={styles.errorCta} activeOpacity={0.85}>
                <Mail size={13} color={colors.textChrome} />
                <Text style={styles.errorCtaText}>support@qdrives.in</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={styles.benefits}>
          <Benefit icon={<ShieldCheck size={16} color={colors.success} />} text="Verified inventory" />
          <Benefit icon={<Zap size={16} color={colors.warning} />} text="Real-time bids" />
          <Benefit icon={<TrendingUp size={16} color={colors.silver} />} text="Live market pulse" />
        </View>

        <Text style={styles.legal}>
          By continuing, you agree to Q Drives' Buyer Terms of Trade and Privacy Policy.{"\n"}
          Q Drives is a closed wholesale network — registration is by invitation only.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Benefit({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <View style={styles.benefit}>
      {icon}
      <Text style={styles.benefitText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { height: 360, justifyContent: 'flex-end' },
  heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,11,13,0.45)' },
  heroVignette: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent', shadowColor: '#000', shadowOpacity: 0.9 },
  heroOverlayAdmin: { backgroundColor: 'rgba(8,8,10,0.85)' },
  backChip: {
    position: 'absolute', top: Platform.OS === 'ios' ? 56 : 22, left: 16,
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    zIndex: 10,
  },
  backChipText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  heroContent: { padding: 24, paddingBottom: 40 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 60 },
  shieldMini: {
    width: 32, height: 38, borderRadius: 8, backgroundColor: colors.red,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.red, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 12, elevation: 8,
  },
  qMini: { color: '#fff', fontSize: 18, fontWeight: '900' },
  brand: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', letterSpacing: 4 },
  brandPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  brandPillText: { color: colors.textChrome, fontSize: 9, fontWeight: '800', letterSpacing: 1.4 },
  brandPillAdmin: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.5)' },
  brandPillTextAdmin: { color: colors.warning },
  heroTitle: { color: colors.textPrimary, fontSize: 34, fontWeight: '800', letterSpacing: -1, lineHeight: 40 },
  heroSub: { color: colors.textChrome, fontSize: 13, marginTop: 12, lineHeight: 18, letterSpacing: 0.3, fontWeight: '500' },

  sheet: {
    flex: 1, backgroundColor: colors.bgCard,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    marginTop: -24,
  },
  sheetContent: { padding: 24, paddingBottom: 60 },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: colors.textSecondary, fontSize: 13.5, marginTop: 6, marginBottom: 28, lineHeight: 19 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, paddingHorizontal: 14, marginBottom: 16,
  },
  cc: { color: colors.textChrome, fontSize: 16, fontWeight: '700' },
  divider: { width: 1, height: 22, backgroundColor: colors.border, marginHorizontal: 12 },
  input: { flex: 1, color: colors.textPrimary, fontSize: 16, paddingVertical: 16, fontWeight: '500' },

  cta: {
    backgroundColor: colors.red,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16, borderRadius: radii.md, gap: 6,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  ctaAdmin: {
    backgroundColor: '#1a1a1c',
    borderWidth: 1, borderColor: colors.warning,
    shadowColor: colors.warning, shadowOpacity: 0.3,
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },

  // Premium access-restricted card
  errorCard: {
    marginTop: 22, padding: 18, borderRadius: radii.md,
    backgroundColor: 'rgba(185,28,28,0.06)',
    borderWidth: 1, borderColor: 'rgba(185,28,28,0.35)',
  },
  errorIconWrap: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(185,28,28,0.12)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(185,28,28,0.3)',
    marginBottom: 12,
  },
  errorTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', letterSpacing: -0.2, marginBottom: 6 },
  errorBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  errorHint: { color: colors.textChrome, fontSize: 12, marginTop: 8, fontStyle: 'italic' },
  errorCta: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 12, alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  errorCtaText: { color: colors.textChrome, fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },

  benefits: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28, paddingHorizontal: 4 },
  benefit: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  benefitText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },

  legal: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: 32, lineHeight: 16, paddingHorizontal: 12 },
});
