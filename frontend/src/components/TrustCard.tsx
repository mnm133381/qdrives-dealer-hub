/**
 * TrustCard — dealer-self-view, institutional / B2B style.
 *
 * Constraints (per product brief):
 *   • No gamification, no leaderboards, no social metrics.
 *   • No exposure of internal scoring formula breakdowns.
 *   • Show only operator-grade KPIs:
 *       Trust score │ Tier │ Settlement % │ Payment reliability
 *       Active disputes │ Account age │ Last operator review
 *   • Surface ACTIVE risk signals so dealer knows what to address.
 *   • No "Top dealer" / "Elite" / "Gold" copy. Only risk language.
 *
 * Mounts on the Profile tab. Pulls /api/reputation/me + /api/reputation/me/timeline.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldCheck, AlertTriangle, ChevronRight, FileWarning, Lock } from 'lucide-react-native';
import { colors } from '../theme';
import { api } from '../api';

function tierToPillLabel(tierKey?: string): string {
  switch (tierKey) {
    case 'trusted': return 'TRUSTED';
    case 'stable': return 'VERIFIED';
    case 'watch': return 'WATCH';
    case 'risky': return 'RISK REVIEW';
    case 'restricted': return 'RESTRICTED';
    default: return 'VERIFIED';
  }
}

function monthsBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 30)));
}

export function TrustCard({ accountCreatedAt }: { accountCreatedAt?: string | Date }) {
  const router = useRouter();
  const [data, setData] = useState<any | null>(null);
  const [openDisputes, setOpenDisputes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rep, mine] = await Promise.all([
          api.reputationMe().catch(() => null),
          api.disputesMine().catch(() => []),
        ]);
        if (cancelled) return;
        setData(rep);
        const open = (mine || []).filter((d: any) =>
          !['resolved', 'withdrawn'].includes(d.state)
        ).length;
        setOpenDisputes(open);
      } catch {} finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <View style={s.card}><ActivityIndicator color={colors.red} size="small" /></View>;
  }
  if (!data) {
    return null;
  }

  const tier = data.tier || {};
  const tierColor = tier.color || colors.text;
  const sigMap: Record<string, any> = {};
  (data.signals || []).forEach((sg: any) => { sigMap[sg.kind] = sg; });

  // Operator-grade KPIs (NOT raw scoring formula — normalized for dealer)
  const settled = sigMap['settlement_completed']?.count || 0;
  const failed = sigMap['settlement_failed']?.count || 0;
  const cancelled = sigMap['cancellation_after_win']?.count || 0;
  const totalAttempted = settled + failed + cancelled;
  const settlementPct = totalAttempted > 0
    ? Math.round((settled / totalAttempted) * 100)
    : null;

  const paymentDelays = sigMap['payment_delayed']?.count || 0;
  const paymentReliability = settled === 0 ? null
    : Math.max(0, Math.round(100 - (paymentDelays / Math.max(settled, 1)) * 100));

  const accountAgeMonths = accountCreatedAt
    ? monthsBetween(new Date(accountCreatedAt as any), new Date())
    : null;

  const lastOperatorReview = (data.signals || [])
    .flatMap((sg: any) => (sg.in_window || []))
    .filter((e: any) => e.source === 'operator')
    .sort((a: any, b: any) => (b.ts || '').localeCompare(a.ts || ''))[0];

  // Risk signals to surface (only those with non-zero count + negative weight)
  const activeRisks = (data.signals || []).filter(
    (sg: any) => sg.count > 0 && sg.weight_per < 0 && sg.delta < 0
  );
  const isRestricted = (data.restrictions || []).length > 0;

  const pillLabel = tierToPillLabel(tier.key);

  return (
    <View style={s.card} testID="trust-card">
      {/* Top: Score + Tier pill, NO comparison metrics */}
      <View style={s.topRow}>
        <View>
          <Text style={s.scoreLbl}>TRUST SCORE</Text>
          <Text style={[s.scoreVal, { color: tierColor }]}>{data.score}</Text>
        </View>
        <View style={[s.tierPill, { backgroundColor: tierColor + '22', borderColor: tierColor }]}>
          <Text style={[s.tierTxt, { color: tierColor }]}>{pillLabel}</Text>
        </View>
      </View>

      {/* Risk banner — only renders if there's something the dealer must address */}
      {(isRestricted || activeRisks.length > 0) && (
        <View style={s.riskBanner}>
          <View style={s.riskBannerHead}>
            <AlertTriangle size={13} color={colors.red} />
            <Text style={s.riskBannerTxt}>
              {isRestricted
                ? 'Account under operator restriction. Bids may be blocked.'
                : 'Risk signals detected on this account.'}
            </Text>
          </View>
          {(data.restrictions || []).map((r: any) => (
            <View key={r.id} style={s.riskItem}>
              <Lock size={11} color={colors.red} />
              <Text style={s.riskItemTxt}>
                {r.kind.toUpperCase().replace(/_/g, ' ')}
                {r.expires_at ? ` · until ${new Date(r.expires_at).toLocaleDateString()}` : ' · open-ended'}
              </Text>
            </View>
          ))}
          {activeRisks.slice(0, 3).map((sg: any) => (
            <View key={sg.kind} style={s.riskItem}>
              <FileWarning size={11} color={'#F59E0B'} />
              <Text style={s.riskItemTxt}>{sg.label} · {sg.count}×</Text>
            </View>
          ))}
        </View>
      )}

      {/* Operator-grade KPI grid — NO raw weights, NO formula */}
      <View style={s.kpiGrid}>
        <KPI label="SETTLEMENT" value={settlementPct == null ? '—' : `${settlementPct}%`} hint={settled > 0 ? `${settled} closed` : 'No deals yet'} />
        <KPI label="PAYMENT" value={paymentReliability == null ? '—' : `${paymentReliability}%`} hint={paymentDelays > 0 ? `${paymentDelays} delays` : 'On-time'} />
        <KPI label="OPEN DSPT" value={openDisputes ?? 0} hint={(openDisputes || 0) > 0 ? 'Action needed' : 'None'} accent={(openDisputes || 0) > 0 ? colors.red : undefined} />
        <KPI label="AGE" value={accountAgeMonths == null ? '—' : `${accountAgeMonths}mo`} hint="Account age" />
      </View>

      {lastOperatorReview && (
        <Text style={s.opReviewLine}>
          Last operator review: {new Date(lastOperatorReview.ts).toLocaleDateString()}
          {lastOperatorReview.note ? ` — ${lastOperatorReview.note.slice(0, 60)}` : ''}
        </Text>
      )}

      <TouchableOpacity onPress={() => router.push('/my-disputes' as any)}
        style={s.disputeLink} activeOpacity={0.7} testID="trust-disputes-link">
        <Text style={s.disputeLinkTxt}>VIEW MY DISPUTES</Text>
        <ChevronRight size={14} color={colors.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

function KPI({ label, value, hint, accent }: any) {
  return (
    <View style={s.kpi}>
      <Text style={s.kpiLbl}>{label}</Text>
      <Text style={[s.kpiVal, accent && { color: accent }]}>{value}</Text>
      <Text style={s.kpiHint}>{hint}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 8, padding: 14, marginHorizontal: 16, marginVertical: 10, borderWidth: 1, borderColor: colors.border, gap: 10 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  scoreLbl: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 0.7 },
  scoreVal: { fontSize: 36, fontWeight: '900', fontVariant: ['tabular-nums'], lineHeight: 38 },
  tierPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1 },
  tierTxt: { fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  riskBanner: { backgroundColor: colors.bg, padding: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.red + '88', gap: 4 },
  riskBannerHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  riskBannerTxt: { color: colors.text, fontSize: 11, fontWeight: '700', flex: 1 },
  riskItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 19 },
  riskItemTxt: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },
  kpiGrid: { flexDirection: 'row', gap: 6 },
  kpi: { flex: 1, padding: 8, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border, gap: 2, alignItems: 'flex-start' },
  kpiLbl: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 0.6 },
  kpiVal: { color: colors.text, fontSize: 16, fontWeight: '900', fontVariant: ['tabular-nums'] },
  kpiHint: { color: colors.textMuted, fontSize: 9 },
  opReviewLine: { color: colors.textMuted, fontSize: 10, fontStyle: 'italic' },
  disputeLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 10, backgroundColor: colors.bg, borderRadius: 4, borderWidth: 1, borderColor: colors.border },
  disputeLinkTxt: { color: colors.text, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
});

/** Confidence pill for AuctionCard. Risk-signaling only. */
export function ConfidencePill({ tierKey, hasRestriction }: { tierKey?: string; hasRestriction?: boolean }) {
  // Per product brief: only display the pill for risk tiers + restrictions.
  // For trusted/stable counterparties, no pill is shown (avoids visual noise).
  if (hasRestriction) {
    return (
      <View style={[pillS.box, { borderColor: colors.red, backgroundColor: colors.red + '22' }]}>
        <Lock size={9} color={colors.red} />
        <Text style={[pillS.txt, { color: colors.red }]}>RESTRICTED</Text>
      </View>
    );
  }
  if (tierKey === 'risky') {
    return (
      <View style={[pillS.box, { borderColor: colors.red, backgroundColor: colors.red + '22' }]}>
        <AlertTriangle size={9} color={colors.red} />
        <Text style={[pillS.txt, { color: colors.red }]}>RISK REVIEW</Text>
      </View>
    );
  }
  if (tierKey === 'watch') {
    return (
      <View style={[pillS.box, { borderColor: '#F59E0B', backgroundColor: '#F59E0B22' }]}>
        <FileWarning size={9} color={'#F59E0B'} />
        <Text style={[pillS.txt, { color: '#F59E0B' }]}>WATCH</Text>
      </View>
    );
  }
  return null;
}

const pillS = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 3, borderWidth: 1 },
  txt: { fontSize: 8, fontWeight: '900', letterSpacing: 0.5 },
});
