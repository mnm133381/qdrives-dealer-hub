/**
 * Verify OTP screen — strictly role-isolated.
 *
 * Calls /auth/dealer/verify-otp or /auth/operator/verify-otp based on the
 * `role` query param threaded through from /(auth)/login. There is NO
 * auto-downgrade: if the operator path is denied, we surface a premium
 * "Operator access denied" error and the user stays on this screen.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Lock, ShieldAlert } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';

const OTP_LEN = 6;

type AccessError = { title: string; body: string; hint: string } | null;

export default function VerifyOtp() {
  const router = useRouter();
  const { phone, role: requestedRole } = useLocalSearchParams<{ phone: string; role?: string }>();
  const { signIn } = useAuth();
  const isAdmin = requestedRole === 'admin';

  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(''));
  const [resendIn, setResendIn] = useState(30);
  const [loading, setLoading] = useState(false);
  const [accessError, setAccessError] = useState<AccessError>(null);
  const inputs = useRef<(TextInput | null)[]>([]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  const handleChange = (val: string, idx: number) => {
    const v = val.replace(/[^0-9]/g, '');
    const next = [...digits];
    if (v.length > 1) {
      // paste flow
      const pasted = v.slice(0, OTP_LEN).split('');
      for (let i = 0; i < OTP_LEN; i++) next[i] = pasted[i] || '';
      setDigits(next);
      inputs.current[Math.min(pasted.length, OTP_LEN - 1)]?.focus();
      if (pasted.length >= OTP_LEN) submit(next.join(''));
      return;
    }
    next[idx] = v;
    setDigits(next);
    if (v && idx < OTP_LEN - 1) inputs.current[idx + 1]?.focus();
    if (next.every((d) => d) && next.join('').length === OTP_LEN) submit(next.join(''));
  };

  const handleKey = (e: any, idx: number) => {
    if (e.nativeEvent.key === 'Backspace' && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
  };

  const submit = async (code: string) => {
    if (loading) return;
    setLoading(true);
    setAccessError(null);
    try {
      const data: any = isAdmin
        ? await api.operatorVerifyOtp(String(phone), code)
        : await api.dealerVerifyOtp(String(phone), code);

      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      await signIn(data.token, data.dealer, data.refresh_token);

      // Strict role isolation — operator endpoint always returns role=admin,
      // dealer endpoint always returns role=dealer. Route accordingly.
      if (data.dealer.role === 'admin') {
        // Operators are pre-verified — never go through dealer KYC.
        router.replace('/(admin)' as any);
      } else if (data.is_new || !data.dealer.kyc_completed) {
        router.replace('/(auth)/kyc');
      } else {
        router.replace('/(tabs)');
      }
    } catch (e: any) {
      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
      const msg = String(e?.message || '');
      if (msg.includes('DEALER_ACCESS_NOT_APPROVED') || msg.includes('DEALER_ACCOUNT_SUSPENDED')) {
        setAccessError({
          title: msg.includes('SUSPENDED') ? 'Account suspended.' : 'Access restricted.',
          body: msg.includes('SUSPENDED')
            ? 'This dealer account has been suspended on the Q Drives network.'
            : 'Your number is not approved on the Q Drives dealer network.',
          hint: 'Please contact Q Drives support.',
        });
      } else if (msg.includes('OPERATOR_ACCESS_DENIED')) {
        setAccessError({
          title: 'Operator access denied.',
          body: 'This number is not authorised for Q Drives operations.',
          hint: 'Operator access is restricted and audited.',
        });
      } else {
        Alert.alert('Verification failed', msg || 'Invalid OTP. Use 123456 for dev.');
        setDigits(Array(OTP_LEN).fill(''));
        inputs.current[0]?.focus();
      }
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    try {
      if (isAdmin) {
        await api.operatorSendOtp(String(phone));
      } else {
        await api.dealerSendOtp(String(phone));
      }
      setResendIn(30);
      Alert.alert('OTP resent', 'A new code is on its way.');
    } catch (e: any) {
      Alert.alert('Failed', e.message);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.root}>
      <TouchableOpacity testID="verify-back-button" onPress={() => router.back()} style={styles.back}>
        <ArrowLeft size={22} color={colors.textPrimary} />
      </TouchableOpacity>

      <View style={styles.iconRow}>
        <View style={[styles.iconBubble, isAdmin && styles.iconBubbleAdmin]}>
          <Lock size={28} color={isAdmin ? colors.warning : colors.red} />
        </View>
        <View style={[styles.rolePill, isAdmin && styles.rolePillAdmin]}>
          <Text style={[styles.rolePillText, isAdmin && styles.rolePillTextAdmin]}>
            {isAdmin ? 'OPERATOR CONSOLE' : 'DEALER NETWORK'}
          </Text>
        </View>
      </View>

      <Text style={styles.title}>Verify number</Text>
      <Text style={styles.sub}>We sent a 6-digit code to {phone}</Text>
      <Text style={styles.devHint}>Dev mode: use code <Text style={styles.devCode}>123456</Text></Text>

      <View style={styles.otpRow} testID="otp-input-row">
        {digits.map((d, i) => (
          <TextInput
            key={i}
            ref={(r) => { inputs.current[i] = r; }}
            value={d}
            onChangeText={(v) => handleChange(v, i)}
            onKeyPress={(e) => handleKey(e, i)}
            keyboardType="number-pad"
            maxLength={6}
            style={[styles.otpInput, d ? styles.otpFilled : null, isAdmin && d ? styles.otpFilledAdmin : null]}
            testID={`otp-digit-${i}`}
          />
        ))}
      </View>

      <TouchableOpacity
        testID="verify-submit-button"
        activeOpacity={0.9}
        style={[styles.cta, isAdmin && styles.ctaAdmin, (digits.some((d) => !d) || loading) && styles.ctaDisabled]}
        onPress={() => submit(digits.join(''))}
        disabled={digits.some((d) => !d) || loading}
      >
        <Text style={styles.ctaText}>{loading ? 'Verifying...' : 'Verify & Continue'}</Text>
      </TouchableOpacity>

      {accessError && (
        <View style={styles.errorCard} testID="verify-access-error">
          <View style={styles.errorIconWrap}>
            <ShieldAlert size={20} color={colors.red} />
          </View>
          <Text style={styles.errorTitle}>{accessError.title}</Text>
          <Text style={styles.errorBody}>{accessError.body}</Text>
          <Text style={styles.errorHint}>{accessError.hint}</Text>
          <TouchableOpacity
            style={styles.errorBackBtn}
            onPress={() => router.replace('/(auth)' as any)}
            activeOpacity={0.85}
            testID="verify-error-back"
          >
            <Text style={styles.errorBackText}>Back to access portal</Text>
          </TouchableOpacity>
        </View>
      )}

      <TouchableOpacity onPress={resend} disabled={resendIn > 0 || !!accessError} style={styles.resend}>
        <Text style={[styles.resendText, (resendIn > 0 || !!accessError) && { color: colors.textMuted }]}>
          {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
        </Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 24, paddingTop: 60 },
  back: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.bgCard, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  iconRow: { marginTop: 36, marginBottom: 18, flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBubble: { width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(185,28,28,0.12)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(185,28,28,0.2)' },
  iconBubbleAdmin: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.3)' },
  rolePill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.12)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)' },
  rolePillText: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  rolePillAdmin: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' },
  rolePillTextAdmin: { color: colors.warning },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  sub: { color: colors.textSecondary, fontSize: 14, marginTop: 8 },
  devHint: { color: colors.textMuted, fontSize: 12, marginTop: 6 },
  devCode: { color: colors.red, fontWeight: '800', letterSpacing: 1 },
  otpRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 36, marginBottom: 28 },
  otpInput: {
    width: 48, height: 60, borderRadius: 12,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    color: colors.textPrimary, fontSize: 22, fontWeight: '700',
    textAlign: 'center',
  },
  otpFilled: { borderColor: colors.red, backgroundColor: 'rgba(185,28,28,0.08)' },
  otpFilledAdmin: { borderColor: colors.warning, backgroundColor: 'rgba(245,158,11,0.08)' },
  cta: {
    backgroundColor: colors.red, paddingVertical: 16, borderRadius: radii.md, alignItems: 'center',
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  ctaAdmin: {
    backgroundColor: '#1a1a1c', borderWidth: 1, borderColor: colors.warning,
    shadowColor: colors.warning,
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },

  errorCard: {
    marginTop: 22, padding: 18, borderRadius: radii.md,
    backgroundColor: 'rgba(185,28,28,0.06)',
    borderWidth: 1, borderColor: 'rgba(185,28,28,0.35)',
  },
  errorIconWrap: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(185,28,28,0.12)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(185,28,28,0.3)',
    marginBottom: 10,
  },
  errorTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '800', marginBottom: 4 },
  errorBody: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  errorHint: { color: colors.textChrome, fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  errorBackBtn: { marginTop: 12, paddingVertical: 10, alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  errorBackText: { color: colors.textPrimary, fontSize: 13, fontWeight: '700', letterSpacing: 0.3 },

  resend: { alignSelf: 'center', marginTop: 22 },
  resendText: { color: colors.textChrome, fontSize: 13, fontWeight: '600' },
});
