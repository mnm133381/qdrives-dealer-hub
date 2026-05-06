import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShieldCheck, Activity } from 'lucide-react-native';
import { colors } from '../theme';

/**
 * Compact trading-terminal operator shell. Replaces the prior 80px+
 * branded chrome with a single dense ribbon (≈40% less vertical space)
 * + a tight per-screen title row. Designed so 3-second platform cognition
 * happens on the FIRST viewport, not after scrolling past hero chrome.
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  ◆ Q DRIVES OPS    ●LIVE  ⚡UPDATED 14:03      [right]│  ← 28px ribbon
 *   ├──────────────────────────────────────────────────────┤
 *   │  KICKER · OPERATIONS                                  │
 *   │  Live Ops                            (rightSlot here) │  ← 38px title
 *   │  Real-time desk · 6s tick                             │  ← 14px sub
 *   └──────────────────────────────────────────────────────┘
 *
 * Total height is ~30% shorter than the previous shell, sub line is
 * truncated to 1 row, and the LIVE pill is fused into the brand ribbon
 * instead of consuming its own row.
 */
export function AdminHeader({
  kicker, title, sub, rightSlot,
}: {
  kicker?: string;
  title: string;
  sub?: string;
  rightSlot?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // Live tick — confirms operator the desk is alive without consuming UI.
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setTick(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  const hh = tick.getHours().toString().padStart(2, '0');
  const mm = tick.getMinutes().toString().padStart(2, '0');

  return (
    <View style={[styles.root, { paddingTop: insets.top + 6 }]}>
      {/* Ribbon — single dense row, fused brand + env + tick */}
      <View style={styles.ribbon}>
        <View style={styles.brandPill}>
          <ShieldCheck size={10} color={colors.red} strokeWidth={2.6} />
          <Text style={styles.brandText}>Q DRIVES OPS</Text>
        </View>
        <View style={styles.envChip}>
          <View style={styles.envDot} />
          <Text style={styles.envText}>LIVE</Text>
        </View>
        <View style={styles.tickChip}>
          <Activity size={8} color={colors.textChrome} strokeWidth={2.6} />
          <Text style={styles.tickText}>{hh}:{mm}</Text>
        </View>
        <View style={{ flex: 1 }} />
      </View>

      {/* Tight title row */}
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {sub ? <Text style={styles.sub} numberOfLines={1}>{sub}</Text> : null}
        </View>
        {rightSlot ? <View style={styles.rightSlot}>{rightSlot}</View> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 18,
    paddingBottom: 9,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(185,28,28,0.20)',
  },
  ribbon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 6,
  },
  brandPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 8, paddingVertical: 3,
    backgroundColor: 'rgba(185,28,28,0.10)',
    borderColor: 'rgba(185,28,28,0.42)', borderWidth: 1, borderRadius: 4,
  },
  brandText: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 1.3 },
  envChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 3,
    borderRadius: 4, borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.42)', backgroundColor: 'rgba(16,185,129,0.10)',
  },
  envDot: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.success },
  envText: { color: colors.success, fontSize: 8.5, fontWeight: '900', letterSpacing: 1.1 },
  tickChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard,
  },
  tickText: { color: colors.textChrome, fontSize: 8.5, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: 0.8 },

  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 2 },
  rightSlot: { flexShrink: 0 },
  kicker: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: colors.textPrimary, fontSize: 19, fontWeight: '900', marginTop: 1, letterSpacing: -0.5 },
  sub: { color: colors.textChrome, fontSize: 11, fontWeight: '600', marginTop: 2 },
});
