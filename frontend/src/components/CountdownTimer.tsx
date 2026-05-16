import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../theme';

/**
 * Live auction countdown. Adaptive units:
 *
 *   ≥ 24 hours  →  D HH MM    (e.g. "6 23 45" for a 7-day listing)
 *   < 24 hours  →  HH MM SS   (legacy short-form, ticks every second)
 *
 * Urgency flag at < 2 min remaining (red highlight, applies in both
 * variants). After expiry shows "ENDED".
 *
 * Persistence: relies ONLY on the wall clock + `endTime` prop, so it
 * survives app refresh / re-login / WebSocket disconnects without
 * drifting. The server-side _enrich_auction adds `seconds_remaining`
 * but we never trust it — we always compute from `end_time` so a 7-day
 * timer stays accurate after a cold start.
 */
export function CountdownTimer({ endTime, compact = false, testID }: { endTime: string; compact?: boolean; testID?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    // 1s tick is fine even for 7-day auctions — re-rendering 3 small
    // text boxes per second has negligible overhead and keeps the
    // last-minute drama feeling live.
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const end = new Date(endTime).getTime();
  const diff = Math.max(0, Math.floor((end - now) / 1000));
  const days = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ended = diff <= 0;
  const urgent = diff > 0 && diff < 120;
  const longForm = days > 0;

  if (compact) {
    return (
      <Text testID={testID} style={[styles.compact, urgent && styles.urgent]}>
        {ended
          ? 'ENDED'
          : longForm
            ? `${days}d ${pad(h)}h ${pad(m)}m`
            : `${pad(h)}:${pad(m)}:${pad(s)}`}
      </Text>
    );
  }

  if (longForm) {
    // ≥ 24h remaining — surface days/hours/minutes (seconds tick is
    // not meaningful for a multi-day window and would be visually
    // noisy on the auction card hero).
    return (
      <View testID={testID} style={styles.row}>
        <TimeBox value={String(days)} label={days === 1 ? 'DAY' : 'DAYS'} urgent={false} />
        <Text style={styles.colon}>:</Text>
        <TimeBox value={pad(h)} label="HRS" urgent={false} />
        <Text style={styles.colon}>:</Text>
        <TimeBox value={pad(m)} label="MIN" urgent={false} />
      </View>
    );
  }

  return (
    <View testID={testID} style={styles.row}>
      <TimeBox value={pad(h)} label="HRS" urgent={urgent} />
      <Text style={styles.colon}>:</Text>
      <TimeBox value={pad(m)} label="MIN" urgent={urgent} />
      <Text style={styles.colon}>:</Text>
      <TimeBox value={pad(s)} label="SEC" urgent={urgent} />
    </View>
  );
}

function TimeBox({ value, label, urgent }: { value: string; label: string; urgent: boolean }) {
  return (
    <View style={[styles.box, urgent && styles.boxUrgent]}>
      <Text style={[styles.value, urgent && styles.valueUrgent]}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  box: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
    minWidth: 56,
  },
  boxUrgent: { borderColor: colors.red, backgroundColor: 'rgba(185,28,28,0.08)' },
  value: { color: colors.textPrimary, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  valueUrgent: { color: colors.red },
  label: { color: colors.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginTop: 2 },
  colon: { color: colors.textMuted, fontSize: 22, fontWeight: '700' },
  compact: { color: colors.textChrome, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  urgent: { color: colors.red },
});
