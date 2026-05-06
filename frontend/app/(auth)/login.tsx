import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, ImageBackground,
  KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight, ShieldCheck, Zap, TrendingUp } from 'lucide-react-native';
import { colors, radii, spacing } from '../../src/theme';
import { api } from '../../src/api';

export default function Login() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  const onSend = async () => {
    const cleaned = phone.replace(/\s/g, '');
    if (cleaned.length < 10) {
      Alert.alert('Invalid phone', 'Please enter a valid 10-digit mobile number.');
      return;
    }
    const e164 = cleaned.startsWith('+') ? cleaned : `+91${cleaned}`;
    setLoading(true);
    try {
      await api.sendOtp(e164);
      router.push({ pathname: '/(auth)/verify', params: { phone: e164 } });
    } catch (e: any) {
      Alert.alert('Failed to send OTP', e.message || 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <ImageBackground
        source={{ uri: 'https://images.unsplash.com/photo-1761229170508-f4791c297af8?w=1400&q=85' }}
        style={styles.hero}
        imageStyle={{ opacity: 0.55 }}
      >
        <View style={styles.heroOverlay} />
        <View style={styles.heroContent}>
          <View style={styles.brandRow}>
            <View style={styles.shieldMini}><Text style={styles.qMini}>Q</Text></View>
            <Text style={styles.brand}>Q DRIVES</Text>
          </View>
          <Text style={styles.heroTitle}>Wholesale auctions{'\n'}for serious dealers.</Text>
          <Text style={styles.heroSub}>Live bidding. Verified inventory. Faster settlement.</Text>
        </View>
      </ImageBackground>

      <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        <View style={styles.sheetHandle} />
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.subtitle}>Enter your registered dealer mobile number</Text>

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
            onChangeText={setPhone}
            style={styles.input}
          />
        </View>

        <TouchableOpacity
          testID="login-send-otp-button"
          activeOpacity={0.9}
          style={[styles.cta, (!phone || loading) && styles.ctaDisabled]}
          onPress={onSend}
          disabled={!phone || loading}
        >
          <Text style={styles.ctaText}>{loading ? 'Sending OTP...' : 'Send OTP'}</Text>
          <ChevronRight size={20} color="#fff" />
        </TouchableOpacity>

        <View style={styles.benefits}>
          <Benefit icon={<ShieldCheck size={16} color={colors.success} />} text="Verified inventory" />
          <Benefit icon={<Zap size={16} color={colors.warning} />} text="Real-time bids" />
          <Benefit icon={<TrendingUp size={16} color={colors.silver} />} text="Live market pulse" />
        </View>

        <Text style={styles.legal}>
          By continuing, you agree to Q Drives' Dealer Terms of Trade and Privacy Policy.
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
  hero: { height: 320, justifyContent: 'flex-end' },
  heroOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,11,13,0.55)' },
  heroContent: { padding: 24, paddingBottom: 32 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 50 },
  shieldMini: {
    width: 32, height: 38, borderRadius: 8, backgroundColor: colors.red,
    alignItems: 'center', justifyContent: 'center',
  },
  qMini: { color: '#fff', fontSize: 18, fontWeight: '900' },
  brand: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 4 },
  heroTitle: { color: colors.textPrimary, fontSize: 32, fontWeight: '800', letterSpacing: -1, lineHeight: 38 },
  heroSub: { color: colors.textChrome, fontSize: 14, marginTop: 10, lineHeight: 20 },

  sheet: {
    flex: 1, backgroundColor: colors.bgCard,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    marginTop: -24,
  },
  sheetContent: { padding: 24, paddingBottom: 60 },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginTop: 6, marginBottom: 28 },

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
  ctaDisabled: { opacity: 0.4 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },

  benefits: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 28, paddingHorizontal: 4 },
  benefit: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  benefitText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },

  legal: { color: colors.textMuted, fontSize: 11, textAlign: 'center', marginTop: 32, lineHeight: 16, paddingHorizontal: 12 },
});
