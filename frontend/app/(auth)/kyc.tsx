import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldCheck, BadgeCheck, Building2, MapPin, FileText, User } from 'lucide-react-native';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';

const STEPS = ['Identity', 'Business', 'Verification'];

export default function Kyc() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ full_name: '', dealership_name: '', city: '', gst_number: '', pan_number: '' });

  const update = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const next = () => {
    if (step === 0 && !form.full_name.trim()) return Alert.alert('Required', 'Please enter your full name');
    if (step === 1 && (!form.dealership_name.trim() || !form.city.trim())) return Alert.alert('Required', 'Dealership name and city are required');
    if (step < 2) setStep(step + 1);
    else submit();
  };

  const submit = async () => {
    setLoading(true);
    try {
      const res = await api.submitKyc(form);
      // res is strictly typed: { success, updated, dealer }
      const updatedDealer = res?.dealer;
      await refresh();
      if (['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(updatedDealer?.role as any)) {
        // Operator accounts should never see this screen — defensive routing.
        router.replace('/(admin)' as any);
      } else {
        router.replace('/(tabs)');
      }
    } catch (e: any) {
      Alert.alert('Failed', e?.message || 'Could not save your profile. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.kicker}>DEALER VERIFICATION</Text>
          <Text style={styles.title}>Complete your KYC</Text>
          <Text style={styles.sub}>Verified dealers gain higher trust scores and faster bid approvals.</Text>
        </View>

        <View style={styles.steps}>
          {STEPS.map((s, i) => (
            <View key={s} style={styles.stepItem}>
              <View style={[styles.stepDot, i <= step && styles.stepDotActive]}>
                <Text style={[styles.stepNum, i <= step && styles.stepNumActive]}>{i + 1}</Text>
              </View>
              <Text style={[styles.stepLabel, i === step && styles.stepLabelActive]}>{s}</Text>
              {i < STEPS.length - 1 && <View style={[styles.stepLine, i < step && styles.stepLineActive]} />}
            </View>
          ))}
        </View>

        {step === 0 && (
          <View style={styles.section}>
            <Field icon={<User size={18} color={colors.textChrome} />} label="Full name" value={form.full_name} onChange={(v) => update('full_name', v)} placeholder="As per PAN card" testID="kyc-full-name" />
          </View>
        )}
        {step === 1 && (
          <View style={styles.section}>
            <Field icon={<Building2 size={18} color={colors.textChrome} />} label="Dealership name" value={form.dealership_name} onChange={(v) => update('dealership_name', v)} placeholder="e.g. Apex Premium Motors" testID="kyc-dealership" />
            <Field icon={<MapPin size={18} color={colors.textChrome} />} label="City" value={form.city} onChange={(v) => update('city', v)} placeholder="Mumbai" testID="kyc-city" />
          </View>
        )}
        {step === 2 && (
          <View style={styles.section}>
            <Field icon={<FileText size={18} color={colors.textChrome} />} label="GST number (optional)" value={form.gst_number} onChange={(v) => update('gst_number', v)} placeholder="29ABCDE1234F1Z5" testID="kyc-gst" autoCapitalize="characters" />
            <Field icon={<FileText size={18} color={colors.textChrome} />} label="PAN number (optional)" value={form.pan_number} onChange={(v) => update('pan_number', v)} placeholder="ABCDE1234F" testID="kyc-pan" autoCapitalize="characters" />
            <View style={styles.trustNote}>
              <BadgeCheck size={18} color={colors.success} />
              <Text style={styles.trustText}>You'll be marked as a verified dealer instantly in dev mode.</Text>
            </View>
          </View>
        )}

        <TouchableOpacity testID="kyc-next-button" activeOpacity={0.9} style={[styles.cta, loading && { opacity: 0.5 }]} onPress={next} disabled={loading}>
          <Text style={styles.ctaText}>{loading ? 'Submitting...' : step < 2 ? 'Continue' : 'Finish & enter Q Drives'}</Text>
        </TouchableOpacity>

        <View style={styles.footerBadge}>
          <ShieldCheck size={14} color={colors.silver} />
          <Text style={styles.footerBadgeText}>Bank-grade encryption · Data never sold</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ icon, label, value, onChange, placeholder, testID, autoCapitalize }: any) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.inputBox}>
        {icon}
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          testID={testID}
          autoCapitalize={autoCapitalize || 'words'}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, paddingTop: 60, paddingBottom: 60 },
  header: { marginBottom: 24 },
  kicker: { color: colors.red, fontSize: 11, fontWeight: '800', letterSpacing: 2 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', marginTop: 6, letterSpacing: -0.5 },
  sub: { color: colors.textSecondary, fontSize: 14, marginTop: 6, lineHeight: 20 },

  steps: { flexDirection: 'row', alignItems: 'center', marginVertical: 28 },
  stepItem: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  stepDot: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  stepDotActive: { backgroundColor: colors.red, borderColor: colors.red },
  stepNum: { color: colors.textMuted, fontWeight: '800', fontSize: 13 },
  stepNumActive: { color: '#fff' },
  stepLabel: { color: colors.textMuted, fontSize: 12, marginLeft: 8, fontWeight: '600' },
  stepLabelActive: { color: colors.textPrimary },
  stepLine: { flex: 1, height: 1, backgroundColor: colors.border, marginHorizontal: 8 },
  stepLineActive: { backgroundColor: colors.red },

  section: { gap: 16 },
  field: {},
  fieldLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 },
  inputBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, paddingHorizontal: 14, gap: 10,
  },
  input: { flex: 1, color: colors.textPrimary, fontSize: 15, paddingVertical: 14, fontWeight: '500' },

  trustNote: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: colors.successBg, borderRadius: 12, marginTop: 6 },
  trustText: { color: colors.success, fontSize: 12, fontWeight: '600', flex: 1 },

  cta: {
    backgroundColor: colors.red, paddingVertical: 16, borderRadius: radii.md, alignItems: 'center', marginTop: 28,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  footerBadge: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 24 },
  footerBadgeText: { color: colors.textMuted, fontSize: 11 },
});
