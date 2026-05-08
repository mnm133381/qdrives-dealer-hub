/**
 * Seller OTP login.
 *
 * Phone-number → mocked OTP `123456` → seller_access JWT.
 * If the phone is not on file, backend returns 404 — we surface a quiet
 * 'contact operations' message (no signup path exists).
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView,
  Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, ShieldCheck, ArrowRight } from 'lucide-react-native';
import { LogoLockupHorizontal } from '../../src/components/Logo';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { storage } from '../../src/storage';
import { TOKEN_KEY } from '../../src/api';
import { useToast } from '../../src/toast';

export default function SellerLogin() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);

  const sendOtp = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) { toast.show('Enter 10-digit mobile', 'error'); return; }
    setBusy(true);
    try {
      await api.sellerSendOtp(`+91${digits}`);
      setStep('otp');
      toast.show('OTP sent. (mock: 123456)', 'success');
    } catch (e: any) {
      toast.show(e.message || 'Failed to send OTP', 'error');
    } finally { setBusy(false); }
  };

  const verify = async () => {
    if ((otp || '').length !== 6) { toast.show('Enter 6-digit OTP', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.sellerVerifyOtp(`+91${phone.replace(/\D/g, '')}`, otp);
      await storage.setItem(TOKEN_KEY, r.token);
      router.replace('/(seller)' as any);
    } catch (e: any) {
      toast.show(e.message || 'Verification failed', 'error');
    } finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { paddingTop: insets.top }]}
    >
      <TouchableOpacity onPress={() => router.replace('/(auth)' as any)} style={styles.back}>
        <ArrowLeft size={16} color={colors.textChrome} />
        <Text style={styles.backText}>Choose access</Text>
      </TouchableOpacity>

      <View style={styles.brandRow}>
        <LogoLockupHorizontal height={26} />
        <View style={styles.pill}>
          <ShieldCheck size={9} color={colors.silver} />
          <Text style={styles.pillText}>VEHICLE OWNER</Text>
        </View>
      </View>

      <Text style={styles.title}>{step === 'phone' ? 'Owner sign-in' : 'Verify OTP'}</Text>
      <Text style={styles.sub}>
        {step === 'phone'
          ? 'Track your vehicle as it moves through the Q Drives auction floor. Access is granted by the operator team.'
          : `We sent a 6-digit code to +91 ${phone.replace(/\D/g, '').slice(0, 5)}-${phone.replace(/\D/g, '').slice(5)}.`}
      </Text>

      {step === 'phone' ? (
        <>
          <View style={styles.inputRow}>
            <Text style={styles.cc}>+91</Text>
            <TextInput
              value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={10}
              placeholder="Mobile number" placeholderTextColor={colors.textMuted}
              style={styles.input} testID="seller-phone"
            />
          </View>
          <TouchableOpacity onPress={sendOtp} disabled={busy} style={[styles.cta, busy && { opacity: 0.5 }]} testID="seller-send-otp">
            {busy ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={styles.ctaText}>Send OTP</Text>
                <ArrowRight size={14} color="#fff" />
              </>
            )}
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TextInput
            value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6}
            placeholder="123456" placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.otpInput]} testID="seller-otp"
          />
          <TouchableOpacity onPress={verify} disabled={busy} style={[styles.cta, busy && { opacity: 0.5 }]} testID="seller-verify">
            {busy ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={styles.ctaText}>Verify & continue</Text>
                <ArrowRight size={14} color="#fff" />
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setStep('phone')} style={styles.secondary}>
            <Text style={styles.secondaryText}>Change number</Text>
          </TouchableOpacity>
        </>
      )}

      <View style={styles.foot}>
        <Text style={styles.footText}>
          Access is operator-controlled. If you don’t have an account on file, contact Q Drives operations.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 22 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 12, alignSelf: 'flex-start' },
  backText: { color: colors.textChrome, fontSize: 12, fontWeight: '700' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  pillText: { color: colors.silver, fontSize: 8.5, fontWeight: '900', letterSpacing: 1 },

  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '900', marginTop: 28, letterSpacing: -0.5 },
  sub: { color: colors.textChrome, fontSize: 13, marginTop: 8, lineHeight: 19, fontWeight: '400' },

  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 0, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, marginTop: 22, overflow: 'hidden' },
  cc: { color: colors.textChrome, fontSize: 14, fontWeight: '800', paddingHorizontal: 14, borderRightWidth: 1, borderRightColor: colors.border, paddingVertical: 14 },
  input: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: '600', padding: 14, backgroundColor: colors.bgCard },
  otpInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, marginTop: 22, letterSpacing: 8, fontSize: 18, fontWeight: '900', textAlign: 'center' },

  cta: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.red, paddingVertical: 14, borderRadius: radii.md },
  ctaText: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.4 },

  secondary: { marginTop: 14, alignItems: 'center' },
  secondaryText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },

  foot: { marginTop: 28, padding: 14, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard },
  footText: { color: colors.textMuted, fontSize: 11, lineHeight: 16, fontWeight: '500' },
});
