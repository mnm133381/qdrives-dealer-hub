import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Activity, TrendingUp } from 'lucide-react-native';
import { colors, formatINR } from '../theme';
import { LivePulse } from './LivePulse';

type Item = { id: string; amount: number; dealer_name: string; car_short: string };

export function ActivityTicker({ items }: { items: Item[] }) {
  const [idx, setIdx] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (items.length <= 1) return;
    const t = setInterval(() => {
      Animated.sequence([
        Animated.timing(fade, { toValue: 0, duration: 220, useNativeDriver: true, easing: Easing.in(Easing.ease) }),
        Animated.timing(fade, { toValue: 1, duration: 320, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
      ]).start();
      setTimeout(() => setIdx((i) => (i + 1) % items.length), 240);
    }, 3200);
    return () => clearInterval(t);
  }, [items.length, fade]);

  if (!items.length) {
    return (
      <View style={styles.wrap}>
        <View style={styles.left}><Activity size={12} color={colors.textMuted} /><Text style={styles.label}>NETWORK</Text></View>
        <Text style={styles.body}>Live bidder activity will appear here</Text>
      </View>
    );
  }
  const item = items[idx];
  return (
    <View style={styles.wrap}>
      <View style={styles.left}>
        <LivePulse size={6} />
        <Text style={styles.label}>LIVE</Text>
      </View>
      <Animated.View style={[styles.body, { opacity: fade }]}>
        <Text numberOfLines={1} style={styles.text}>
          <Text style={styles.dealer}>{item.dealer_name}</Text>
          <Text style={styles.muted}> bid </Text>
          <Text style={styles.amount}>{formatINR(item.amount)}</Text>
          <Text style={styles.muted}> on </Text>
          <Text style={styles.car}>{item.car_short}</Text>
        </Text>
      </Animated.View>
      <TrendingUp size={12} color={colors.success} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: 'rgba(22,24,29,0.85)',
    borderColor: colors.border, borderWidth: 1,
    borderRadius: 999, marginHorizontal: 20, marginBottom: 14,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { color: colors.red, fontSize: 9, fontWeight: '800', letterSpacing: 1.6 },
  body: { flex: 1, overflow: 'hidden' },
  text: { fontSize: 12 },
  dealer: { color: colors.textPrimary, fontWeight: '800' },
  muted: { color: colors.textMuted, fontWeight: '500' },
  amount: { color: colors.red, fontWeight: '800' },
  car: { color: colors.textChrome, fontWeight: '600' },
});
