import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Lock } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';

const OTP_LEN = 6;

export default function VerifyOtp() {
  const router = useRouter();
  const { phone, role: requestedRole } = useLocalSearchParams<{ phone: string; role?: string }>();
  const { signIn } = useAuth();
  const wantedAdmin = requestedRole === 'admin';

  const [digits, setDigits] = useState<string[]>(Array(OTP_LEN).fill(''));
  const [resendIn, setResendIn] = useState(30);
  const [loading, setLoading] = useState(false);
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
    try {
      const data: any = await api.verifyOtp(String(phone), code);
      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      await signIn(data.token, data.dealer);
      // If the user picked the admin entry but the phone isn't on the admin
      // allow-list, surface that explicitly so they understand why they land
      // in the dealer marketplace instead of the operator console.
      if (wantedAdmin && data.dealer.role !== 'admin') {
        Alert.alert(
          'Operator access not granted',
          'This number is not on the Q Drives operator allow-list. You will be signed in as a dealer.',
          [{ text: 'OK' }],
        );
      }
      if (data.is_new || !data.dealer.kyc_completed) {
        router.replace('/(auth)/kyc');
      } else if (data.dealer.role === 'admin') {
        router.replace('/(admin)' as any);
      } else {
        router.replace('/(tabs)');
      }
    } catch (e: any) {
      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
      Alert.alert('Verification failed', e.message || 'Invalid OTP. Use 123456 for dev.');
      setDigits(Array(OTP_LEN).fill(''));
      inputs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    try {
      await api.sendOtp(String(phone));
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
        <View style={styles.iconBubble}><Lock size={28} color={colors.red} /></View>
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
            style={[styles.otpInput, d ? styles.otpFilled : null]}
            testID={`otp-digit-${i}`}
          />
        ))}
      </View>

      <TouchableOpacity
        testID="verify-submit-button"
        activeOpacity={0.9}
        style={[styles.cta, (digits.some((d) => !d) || loading) && styles.ctaDisabled]}
        onPress={() => submit(digits.join(''))}
        disabled={digits.some((d) => !d) || loading}
      >
        <Text style={styles.ctaText}>{loading ? 'Verifying...' : 'Verify & Continue'}</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={resend} disabled={resendIn > 0} style={styles.resend}>
        <Text style={[styles.resendText, resendIn > 0 && { color: colors.textMuted }]}>
          {resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
        </Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 24, paddingTop: 60 },
  back: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.bgCard, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border },
  iconRow: { marginTop: 36, marginBottom: 18, alignItems: 'flex-start' },
  iconBubble: { width: 56, height: 56, borderRadius: 16, backgroundColor: 'rgba(185,28,28,0.12)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(185,28,28,0.2)' },
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
  cta: {
    backgroundColor: colors.red, paddingVertical: 16, borderRadius: radii.md, alignItems: 'center',
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  resend: { alignSelf: 'center', marginTop: 22 },
  resendText: { color: colors.textChrome, fontSize: 13, fontWeight: '600' },
});
