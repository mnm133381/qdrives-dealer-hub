/**
 * PendingApprovalCard — premium blocked-state card surfacing the
 * dealer's current account status (pending / suspended / revoked).
 * Mounted on home + profile when dealer.status !== 'approved'.
 *
 * Direction: B2B trust intelligence, not consumer reviews. Copy is
 * operator-friendly and reassuring, no marketing fluff.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Lock, ShieldAlert, ShieldOff, Clock3 } from 'lucide-react-native';
import { colors, radii } from '../theme';

type Status = 'pending' | 'suspended' | 'revoked' | 'approved' | string | null | undefined;

export function PendingApprovalCard({ status, compact = false }: { status: Status; compact?: boolean }) {
  if (!status || status === 'approved') return null;

  const map: Record<string, { icon: any; tint: string; kicker: string; title: string; body: string; footer?: string }> = {
    pending: {
      icon: Clock3,
      tint: colors.warning,
      kicker: 'PENDING APPROVAL',
      title: 'Pending Approval',
      body: 'Your dealership account is currently under review.\n\nYou can browse live auctions and monitor bidding activity while approval is pending.\n\nBidding and purchases activate immediately after approval.',
      footer: 'Approval typically completed within business hours',
    },
    suspended: {
      icon: ShieldAlert,
      tint: colors.red,
      kicker: 'ACCOUNT SUSPENDED',
      title: 'Bidding is paused on your account',
      body: 'Your Q Drives account has been temporarily suspended. Browsing remains available so you can stay informed. Please contact support to resolve this.',
    },
    revoked: {
      icon: ShieldOff,
      tint: colors.red,
      kicker: 'ACCESS REVOKED',
      title: 'Account access revoked',
      body: 'Your Q Drives access has been revoked. Contact Q Drives operations for further information.',
    },
  };

  const entry = map[status as string] || map.pending;
  const Icon = entry.icon;

  return (
    <View style={[styles.card, { borderColor: entry.tint + '55', backgroundColor: entry.tint + '0A' }]} testID={`pending-card-${status}`}>
      <View style={styles.head}>
        <View style={[styles.iconWrap, { backgroundColor: entry.tint + '14', borderColor: entry.tint + '55' }]}>
          <Icon size={16} color={entry.tint} strokeWidth={2.4} />
        </View>
        <Text style={[styles.kicker, { color: entry.tint }]}>{entry.kicker}</Text>
      </View>
      <Text style={styles.title}>{entry.title}</Text>
      {!compact && <Text style={styles.body}>{entry.body}</Text>}
      {!compact && entry.footer && (
        <View style={[styles.footerPill, { borderColor: entry.tint + '40', backgroundColor: entry.tint + '12' }]}>
          <Clock3 size={10} color={entry.tint} strokeWidth={2.4} />
          <Text style={[styles.footerPillText, { color: entry.tint }]}>{entry.footer}</Text>
        </View>
      )}
      {compact && (
        <View style={styles.compactPill}>
          <Lock size={11} color={entry.tint} strokeWidth={2.4} />
          <Text style={[styles.compactPillText, { color: entry.tint }]}>Bidding locked</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: radii.lg, borderWidth: 1, marginBottom: 14 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  iconWrap: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  kicker: { fontSize: 10.5, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 16, fontWeight: '900', marginBottom: 6, letterSpacing: -0.2 },
  body: { color: colors.textChrome, fontSize: 12.5, fontWeight: '600', lineHeight: 18 },
  footerPill: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  footerPillText: { fontSize: 10.5, fontWeight: '900', letterSpacing: 0.5 },
  compactPill: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.bgCard },
  compactPillText: { fontSize: 10.5, fontWeight: '900', letterSpacing: 0.8 },
});
