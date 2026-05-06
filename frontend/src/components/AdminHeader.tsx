import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShieldCheck } from 'lucide-react-native';
import { colors } from '../theme';

/**
 * Persistent ADMIN OPS pill + screen kicker / title used across the admin
 * shell. Kept lightweight so screens can compose their own content below.
 */
export function AdminHeader({ kicker, title, sub }: { kicker?: string; title: string; sub?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]}>
      <View style={styles.topRow}>
        <View style={styles.adminPill}>
          <ShieldCheck size={11} color={colors.red} />
          <Text style={styles.adminPillText}>Q DRIVES · ADMIN OPS</Text>
        </View>
        <View style={styles.envPill}>
          <View style={styles.envDot} />
          <Text style={styles.envText}>LIVE</Text>
        </View>
      </View>
      {kicker && <Text style={styles.kicker}>{kicker}</Text>}
      <Text style={styles.title}>{title}</Text>
      {sub && <Text style={styles.sub}>{sub}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 20, paddingBottom: 12, backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: 'rgba(185,28,28,0.16)' },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  adminPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)', borderWidth: 1, borderRadius: 999 },
  adminPillText: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  envPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(16,185,129,0.4)', backgroundColor: 'rgba(16,185,129,0.08)' },
  envDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.success },
  envText: { color: colors.success, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  kicker: { color: colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.6, textTransform: 'uppercase' },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '800', marginTop: 4, letterSpacing: -0.4 },
  sub: { color: colors.textChrome, fontSize: 12, marginTop: 4, lineHeight: 18 },
});
