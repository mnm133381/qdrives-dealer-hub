import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search, Sparkles, Camera, ImageIcon, Clock, ArrowRight } from 'lucide-react-native';
import { colors, radii, formatINRFull, formatINR } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';

const STOCK_GALLERY = [
  'https://images.unsplash.com/photo-1768965468641-39e87aa78a9d?w=1400&q=85',
  'https://images.unsplash.com/photo-1764089859664-30aa6919ef0b?w=1400&q=85',
  'https://images.unsplash.com/photo-1761229170508-f4791c297af8?w=1400&q=85',
  'https://images.pexels.com/photos/29755707/pexels-photo-29755707.jpeg?auto=compress&cs=tinysrgb&w=1400',
];

const FUEL = ['Petrol', 'Diesel', 'CNG', 'Electric'];
const TRANS = ['Manual', 'Automatic'];

export default function Sell() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [reg, setReg] = useState('');
  const [autofilled, setAutofilled] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [aiEst, setAiEst] = useState<any>(null);
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({
    make: '', model: '', variant: '', year: 2022,
    fuel_type: 'Diesel', transmission: 'Automatic',
    km_driven: 30000, color: 'Black', owners: 1,
    starting_bid: 1500000, reserve_price: 1700000, duration_minutes: 60,
  });

  const u = (k: string, v: any) => setForm((p) => ({ ...p, [k]: v }));

  const lookup = () => {
    if (!reg.trim()) return toast.show('Type a registration number first', 'error');
    setForm({
      ...form,
      make: 'Hyundai', model: 'Tucson', variant: 'Signature', year: 2022,
      fuel_type: 'Petrol', transmission: 'Automatic',
      km_driven: 24800, color: 'Phantom Black', owners: 1,
      starting_bid: 2100000, reserve_price: 2350000,
    });
    setAutofilled(true);
    toast.show('RC details auto-filled', 'success');
  };

  const estimate = async () => {
    if (!form.make || !form.model) return toast.show('Lookup the reg first', 'error');
    setEstimating(true);
    try {
      const res = await api.priceEstimate({
        make: form.make, model: form.model, year: form.year,
        km_driven: form.km_driven, fuel_type: form.fuel_type,
        owners: form.owners, condition_score: 8.5,
      });
      setAiEst(res);
      u('starting_bid', Math.max(50000, Math.round(((res as any).market_low_inr || 1000000) * 0.95 / 1000) * 1000));
      u('reserve_price', Math.round(((res as any).estimated_price_inr || 1200000) / 1000) * 1000);
      toast.show('AI estimate ready', 'success');
    } catch (e: any) {
      toast.show(e.message || 'AI estimate failed', 'error');
    } finally {
      setEstimating(false);
    }
  };

  const launch = async () => {
    if (!form.make || !form.model || !reg) return toast.show('Lookup registration first', 'error');
    setCreating(true);
    try {
      const res: any = await api.createCar({
        ...form,
        registration_number: reg.toUpperCase(),
        images: STOCK_GALLERY,
        description: `${form.year} ${form.make} ${form.model} listed for wholesale auction.`,
      });
      toast.show('Auction launched successfully', 'success');
      router.push(`/auction/${res.auction.id}`);
      // reset form for next listing
      setReg('');
      setAutofilled(false);
      setAiEst(null);
    } catch (e: any) {
      toast.show(e.message || 'Failed to launch', 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.kicker}>SELL ON Q DRIVES</Text>
          <Text style={styles.title}>Launch an auction</Text>
          <Text style={styles.sub}>Verified inventory. Maximum bidder reach. Settlement in 48 hours.</Text>
        </View>

        {/* Step 1: Reg lookup */}
        <View style={styles.section}>
          <Text style={styles.label}>Registration number</Text>
          <View style={styles.lookupRow}>
            <View style={styles.lookupInput}>
              <Search size={16} color={colors.textMuted} />
              <TextInput
                placeholder="MH02AB1234"
                placeholderTextColor={colors.textMuted}
                value={reg}
                onChangeText={setReg}
                autoCapitalize="characters"
                style={styles.input}
                testID="sell-reg-input"
              />
            </View>
            <TouchableOpacity onPress={lookup} style={styles.lookupBtn} testID="sell-lookup-btn">
              <Text style={styles.lookupBtnText}>Lookup</Text>
            </TouchableOpacity>
          </View>

          {autofilled && (
            <View style={styles.autoFillCard}>
              <Text style={styles.autoFillLabel}>RC AUTO-FILLED</Text>
              <Text style={styles.autoFillTitle}>{form.year} {form.make} {form.model} {form.variant}</Text>
              <Text style={styles.autoFillSub}>{form.fuel_type} · {form.transmission} · {form.km_driven.toLocaleString('en-IN')} km · {form.color}</Text>
            </View>
          )}
        </View>

        {/* Step 2: Photos */}
        <View style={styles.section}>
          <Text style={styles.label}>Photos & inspection</Text>
          <View style={styles.uploadGrid}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.uploadCell}>
                {i === 0 ? <Camera size={20} color={colors.textChrome} /> : <ImageIcon size={20} color={colors.textMuted} />}
                <Text style={styles.uploadLabel}>{i === 0 ? 'Front' : i === 1 ? 'Back' : i === 2 ? 'Side' : 'Interior'}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.helper}>Stock gallery will be used in dev mode</Text>
        </View>

        {/* Step 3: AI estimate */}
        {autofilled && (
          <View style={styles.section}>
            <View style={styles.aiCard}>
              <View style={styles.aiHead}>
                <Sparkles size={18} color={colors.red} />
                <Text style={styles.aiTitle}>AI Wholesale Price Estimate</Text>
              </View>
              {aiEst ? (
                <>
                  <Text style={styles.aiPrice}>{formatINRFull(aiEst.estimated_price_inr)}</Text>
                  <Text style={styles.aiRange}>
                    Range {formatINR(aiEst.market_low_inr)} – {formatINR(aiEst.market_high_inr)} · {aiEst.confidence} confidence
                  </Text>
                  <Text style={styles.aiReason}>{aiEst.reasoning}</Text>
                </>
              ) : (
                <TouchableOpacity onPress={estimate} disabled={estimating} style={styles.aiBtn} testID="sell-ai-estimate-btn">
                  {estimating ? <ActivityIndicator color="#fff" /> : <Text style={styles.aiBtnText}>Get instant AI estimate</Text>}
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Step 4: Pricing */}
        {autofilled && (
          <View style={styles.section}>
            <Text style={styles.label}>Reserve price</Text>
            <View style={styles.priceBox}>
              <Text style={styles.priceVal}>{formatINRFull(form.reserve_price)}</Text>
              <Text style={styles.priceHelper}>Bidding will start at {formatINR(form.starting_bid)}</Text>
            </View>
            <View style={styles.priceQuickRow}>
              {[-100000, -50000, 50000, 100000].map((d) => (
                <TouchableOpacity key={d} onPress={() => u('reserve_price', Math.max(50000, form.reserve_price + d))} style={styles.priceChip}>
                  <Text style={styles.priceChipText}>{d > 0 ? '+' : ''}{formatINR(d)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Step 5: Duration */}
        {autofilled && (
          <View style={styles.section}>
            <Text style={styles.label}>Auction duration</Text>
            <View style={styles.durRow}>
              {[30, 60, 120, 240].map((d) => (
                <TouchableOpacity key={d} onPress={() => u('duration_minutes', d)} style={[styles.durPill, form.duration_minutes === d && styles.durPillActive]}>
                  <Clock size={12} color={form.duration_minutes === d ? colors.red : colors.textChrome} />
                  <Text style={[styles.durText, form.duration_minutes === d && { color: colors.red }]}>{d} min</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.dealerInterest}>
              <Text style={styles.dealerInterestNum}>14</Text>
              <Text style={styles.dealerInterestLabel}>dealers actively watching{'\n'}cars in this segment</Text>
            </View>
          </View>
        )}

        {autofilled && (
          <TouchableOpacity onPress={launch} disabled={creating} style={styles.launch} testID="sell-launch-btn">
            <Text style={styles.launchText}>{creating ? 'Launching...' : 'Launch Auction'}</Text>
            <ArrowRight size={18} color="#fff" />
          </TouchableOpacity>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, marginBottom: 18 },
  kicker: { color: colors.red, fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', marginTop: 6, letterSpacing: -0.5 },
  sub: { color: colors.textSecondary, fontSize: 14, marginTop: 4, lineHeight: 20 },

  section: { paddingHorizontal: 20, marginBottom: 22 },
  label: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' },

  lookupRow: { flexDirection: 'row', gap: 8 },
  lookupInput: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, paddingHorizontal: 12,
  },
  input: { flex: 1, color: colors.textPrimary, fontSize: 15, paddingVertical: 14, fontWeight: '600' },
  lookupBtn: { backgroundColor: colors.red, paddingHorizontal: 18, justifyContent: 'center', borderRadius: radii.md },
  lookupBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  autoFillCard: {
    marginTop: 12, padding: 14, backgroundColor: 'rgba(16,185,129,0.06)',
    borderColor: 'rgba(16,185,129,0.3)', borderWidth: 1, borderRadius: radii.md,
  },
  autoFillLabel: { color: colors.success, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  autoFillTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginTop: 4 },
  autoFillSub: { color: colors.textChrome, fontSize: 12, marginTop: 4 },

  uploadGrid: { flexDirection: 'row', gap: 8 },
  uploadCell: {
    flex: 1, aspectRatio: 1,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderStyle: 'dashed',
    borderRadius: radii.md, alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  uploadLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  helper: { color: colors.textMuted, fontSize: 11, marginTop: 8 },

  aiCard: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.lg, padding: 16 },
  aiHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  aiTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  aiPrice: { color: colors.textPrimary, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  aiRange: { color: colors.textChrome, fontSize: 12, marginTop: 4 },
  aiReason: { color: colors.textSecondary, fontSize: 12, marginTop: 8, lineHeight: 18 },
  aiBtn: { backgroundColor: 'rgba(185,28,28,0.16)', borderColor: colors.red, borderWidth: 1, paddingVertical: 12, borderRadius: radii.md, alignItems: 'center' },
  aiBtnText: { color: colors.red, fontWeight: '800', fontSize: 13 },

  priceBox: {
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, padding: 16,
  },
  priceVal: { color: colors.textPrimary, fontSize: 26, fontWeight: '800' },
  priceHelper: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  priceQuickRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  priceChip: { flex: 1, paddingVertical: 8, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: 999, alignItems: 'center' },
  priceChipText: { color: colors.textChrome, fontSize: 11, fontWeight: '700' },

  durRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  durPill: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
  },
  durPillActive: { backgroundColor: 'rgba(185,28,28,0.12)', borderColor: colors.red },
  durText: { color: colors.textChrome, fontSize: 12, fontWeight: '700' },

  dealerInterest: {
    marginTop: 14, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md,
  },
  dealerInterestNum: { color: colors.red, fontSize: 30, fontWeight: '800' },
  dealerInterestLabel: { color: colors.textChrome, fontSize: 12, lineHeight: 16, flex: 1 },

  launch: {
    marginHorizontal: 20, marginTop: 8,
    backgroundColor: colors.red, paddingVertical: 16, borderRadius: radii.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  launchText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
