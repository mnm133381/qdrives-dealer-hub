import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Pressable } from 'react-native';
import { colors, formatINR, maskRegNo, radii, spacing } from '../theme';
import { CountdownTimer } from './CountdownTimer';
import { LivePulse } from './LivePulse';
import { Heart, Gauge, Calendar, Fuel, Eye, Flame, ShieldCheck, BadgeCheck } from 'lucide-react-native';
import { firstCarImage } from '../imageUri';

type Props = {
  auction: any;
  onPress?: () => void;
  onWatch?: () => void;
  watching?: boolean;
  testID?: string;
};

export function AuctionCard({ auction, onPress, onWatch, watching, testID }: Props) {
  const car = auction.car || {};
  const seller = auction.seller || {};
  const isLive = auction.status === 'live';
  // Reserve-price privacy: prefer backend-computed flag so bidders
  // never need the literal reserve_price (which the API now strips).
  const reserveMet = typeof (auction as any).reserve_met === 'boolean'
    ? (auction as any).reserve_met
    : (auction.current_bid || 0) >= (auction.reserve_price || 0);
  const isHot = (auction.total_bids || 0) >= 10;
  const viewerCount = auction.interested_dealers || 0;

  return (
    <TouchableOpacity
      activeOpacity={0.92}
      onPress={onPress}
      testID={testID}
      style={[styles.card, isLive && styles.cardLive]}
    >
      {/* Faint red top-edge ambient highlight for active auctions —
          embeds the card into the page surface vs. floating box look. */}
      {isLive && <View style={styles.activeEdge} pointerEvents="none" />}

      <View style={styles.imageWrap}>
        {/* Image source resolution rules (production):
             1. Prefer the FIRST entry from car.images[] (server now
                returns uploaded photo URLs via the media join in
                _enrich_auction).
             2. Relative paths like "/api/media/<id>/file" are prefixed
                with EXPO_PUBLIC_BACKEND_URL so the native APK can
                fetch them.
             3. If no image exists at all we render an empty placeholder
                tile — NEVER fall back to a hardcoded demo URL, that
                was the "Audi over Honda Amaze" bug. */}
        {(() => {
          const uri = firstCarImage(car.images);
          if (!uri) {
            return <View style={[styles.image, styles.imagePlaceholder]}><Text style={styles.placeholderText}>No photo yet</Text></View>;
          }
          return <Image source={{ uri }} style={styles.image} />;
        })()}
        <View style={styles.imageGradTop} />
        <View style={styles.imageGradBottom} />

        {/* Top row: live + hot, watch */}
        <View style={styles.topRow}>
          <View style={styles.topLeft}>
            {isLive && (
              <View style={styles.liveBadge}>
                <LivePulse size={6} />
                <Text style={styles.liveText}>LIVE</Text>
              </View>
            )}
            {auction.status === 'upcoming' && (
              <View style={[styles.statusBadge, { borderColor: colors.warning }]}>
                <Text style={[styles.statusText, { color: colors.warning }]}>UPCOMING</Text>
              </View>
            )}
            {auction.status === 'ended' && (
              <View style={[styles.statusBadge, { borderColor: colors.textMuted }]}>
                <Text style={[styles.statusText, { color: colors.textSecondary }]}>ENDED</Text>
              </View>
            )}
            {isLive && isHot && (
              <View style={styles.hotBadge}>
                <Flame size={10} color="#fff" />
                <Text style={styles.hotText}>HOT</Text>
              </View>
            )}
          </View>
          {onWatch && (
            <Pressable onPress={onWatch} style={styles.heart} hitSlop={10} testID={`${testID}-watch`}>
              <Heart size={16} color={watching ? colors.red : colors.textChrome} fill={watching ? colors.red : 'transparent'} />
            </Pressable>
          )}
        </View>

        {/* Reg plate at bottom-right */}
        <View style={styles.regPlate}>
          <Text style={styles.regText}>{maskRegNo(car.registration_number) || 'REG —'}</Text>
        </View>

        {/* Title overlay */}
        <View style={styles.bottomGradientInfo}>
          <Text style={styles.titleOverlay} numberOfLines={1}>
            {car.year} {car.make} {car.model}
          </Text>
          <Text style={styles.variantOverlay} numberOfLines={1}>
            {car.variant ? `${car.variant} · ` : ''}{car.color}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        {/* Seller / trust strip */}
        <View style={styles.trustStrip}>
          {seller.verified ? (
            <BadgeCheck size={12} color={colors.success} />
          ) : (
            <ShieldCheck size={12} color={colors.textMuted} />
          )}
          <Text style={styles.trustText} numberOfLines={1}>
            {seller.dealership_name || 'Verified Dealer'}{seller.city ? ` · ${seller.city}` : ''}
          </Text>
          {isLive && (
            <View style={styles.viewerPill}>
              <Eye size={10} color={colors.textChrome} />
              <Text style={styles.viewerText}>{viewerCount}</Text>
            </View>
          )}
        </View>

        {/* Meta row */}
        <View style={styles.metaRow}>
          <Meta icon={<Calendar size={11} color={colors.textSecondary} />} text={`${car.year || ''}`} />
          <View style={styles.metaDot} />
          <Meta icon={<Gauge size={11} color={colors.textSecondary} />} text={`${(car.km_driven || 0).toLocaleString('en-IN')} km`} />
          <View style={styles.metaDot} />
          <Meta icon={<Fuel size={11} color={colors.textSecondary} />} text={car.fuel_type || ''} />
        </View>

        <View style={styles.divider} />

        <View style={styles.priceRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bidLabel}>{isLive ? 'CURRENT BID' : auction.status === 'upcoming' ? 'STARTING' : 'FINAL BID'}</Text>
            <Text style={styles.bidValue}>{formatINR(auction.current_bid || auction.starting_bid)}</Text>
            <Text style={styles.bidsNote}>{auction.total_bids || 0} bids · {auction.interested_dealers || 0} watching</Text>
          </View>
          <View style={styles.timerWrap}>
            {isLive ? (
              <>
                <Text style={styles.endsIn}>ENDS IN</Text>
                <CountdownTimer endTime={auction.end_time} compact />
              </>
            ) : auction.status === 'upcoming' ? (
              <Text style={styles.timerCompactMuted}>Starts soon</Text>
            ) : (
              <Text style={styles.timerCompactMuted}>{auction.total_bids} bids placed</Text>
            )}
          </View>
        </View>

        <View style={styles.footerRow}>
          {/* Canonical inspection — prefer car.inspection.* (joined
              by _enrich_auction from db.inspections). Fall back to
              flat car.* for back-compat with not-yet-migrated screens. */}
          <View style={styles.scorePill}>
            <Text style={styles.scoreLabel}>INSPECTION</Text>
            <Text style={styles.scoreVal}>
              {(() => {
                const s = (car.inspection?.inspection_score ?? car.inspection_score);
                if (typeof s !== 'number') return '—';
                // Whole numbers without trailing ".0" (10/10 not 10.0/10).
                const display = Number.isInteger(s) ? String(s) : s.toFixed(1);
                return <>{display}<Text style={styles.scoreSuffix}>/10</Text></>;
              })()}
            </Text>
          </View>
          <View style={[styles.scorePill, reserveMet ? styles.reserveMet : styles.reserveNotMet]}>
            <Text style={[styles.scoreLabel, reserveMet ? { color: colors.success } : { color: colors.warning }]}>
              {reserveMet ? 'RESERVE' : 'RESERVE'}
            </Text>
            <Text style={[styles.scoreVal, reserveMet ? { color: colors.success } : { color: colors.warning }]}>
              {reserveMet ? 'MET' : 'NOT MET'}
            </Text>
          </View>
          <View style={styles.scorePill}>
            <Text style={styles.scoreLabel}>GRADE</Text>
            {/* P0 trust fix: NEVER fabricate "A" for unscored cars.
                Show em-dash so the marketplace tile honestly reflects
                that no inspection has been recorded yet. */}
            <Text style={styles.scoreVal}>
              {(() => {
                const g = (car.inspection?.condition_grade ?? car.condition_grade);
                return g ? String(g).toUpperCase() : '—';
              })()}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function Meta({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <View style={styles.metaItem}>
      {icon}
      <Text style={styles.metaText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: spacing.lg,
    // Premium shadow depth — embeds the card into the page surface
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 5,
  },
  cardLive: {
    borderColor: 'rgba(255,30,45,0.35)',
    shadowColor: colors.red,
    shadowOpacity: 0.20,
    shadowRadius: 14,
  },
  // Faint red top-edge ambient — runs along the top inside edge of live cards
  activeEdge: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 1.5,
    backgroundColor: colors.red,
    opacity: 0.85,
    zIndex: 2,
  },
  imageWrap: { width: '100%', height: 248, position: 'relative', backgroundColor: '#000' },
  image: { width: '100%', height: '100%' },
  imagePlaceholder: { backgroundColor: colors.bgCard, alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  imageGradTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 80, backgroundColor: 'rgba(5,5,8,0.65)' },
  imageGradBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 130, backgroundColor: 'rgba(5,5,8,0.92)' },

  topRow: { position: 'absolute', top: 14, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  topLeft: { flexDirection: 'row', gap: 6 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.red, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, backgroundColor: 'rgba(5,5,8,0.62)' },
  statusText: { fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  hotBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(245,158,11,0.95)' },
  hotText: { color: '#0B0B0D', fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },

  heart: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(5,5,8,0.65)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },

  regPlate: { position: 'absolute', top: 14, right: 60, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 6 },
  regText: { color: '#0B0B0D', fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },

  bottomGradientInfo: { position: 'absolute', bottom: 14, left: 16, right: 16 },
  // Stronger title contrast — was 19/800/-0.4
  titleOverlay: { color: colors.textPrimary, fontSize: 21, fontWeight: '900', letterSpacing: -0.5 },
  variantOverlay: { color: 'rgba(245,247,250,0.62)', fontSize: 12, marginTop: 4, letterSpacing: 0.2, fontWeight: '500' },

  body: { padding: 16 },
  trustStrip: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  trustText: { color: colors.textSecondary, fontSize: 11, fontWeight: '600', letterSpacing: 0.2, flex: 1 },
  viewerPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.bgDeep, borderWidth: 1, borderColor: colors.border },
  viewerText: { color: colors.textChrome, fontSize: 10, fontWeight: '700' },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.border },
  metaText: { color: colors.textSecondary, fontSize: 11, fontWeight: '500' },

  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 14 },

  priceRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  bidLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 6 },
  // Stronger metric emphasis — was 24/800
  bidValue: { color: colors.textPrimary, fontSize: 26, fontWeight: '900', letterSpacing: -0.7, fontVariant: ['tabular-nums'] },
  bidsNote: { color: colors.textMuted, fontSize: 11, marginTop: 5, fontWeight: '500' },
  timerWrap: { alignItems: 'flex-end' },
  endsIn: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 6 },
  timerCompactMuted: { color: colors.textSecondary, fontSize: 12, fontWeight: '500' },

  footerRow: { flexDirection: 'row', gap: 6, marginTop: 14 },
  scorePill: {
    flex: 1, backgroundColor: colors.bgDeep,
    borderRadius: radii.md, paddingVertical: 9, paddingHorizontal: 6,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center',
  },
  reserveMet: { borderColor: 'rgba(0,208,132,0.32)', backgroundColor: 'rgba(0,208,132,0.06)' },
  reserveNotMet: { borderColor: 'rgba(245,158,11,0.28)', backgroundColor: 'rgba(245,158,11,0.05)' },
  scoreLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.0 },
  scoreVal: { color: colors.textChrome, fontSize: 13, fontWeight: '800', marginTop: 4 },
  scoreSuffix: { color: colors.textMuted, fontSize: 11, fontWeight: '500' },
});
