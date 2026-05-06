import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image, Pressable } from 'react-native';
import { colors, formatINR, radii, spacing } from '../theme';
import { CountdownTimer } from './CountdownTimer';
import { LivePulse } from './LivePulse';
import { Heart, Gauge, Calendar, Fuel } from 'lucide-react-native';

type Props = {
  auction: any;
  onPress?: () => void;
  onWatch?: () => void;
  watching?: boolean;
  testID?: string;
};

export function AuctionCard({ auction, onPress, onWatch, watching, testID }: Props) {
  const car = auction.car || {};
  const isLive = auction.status === 'live';
  const reserveMet = (auction.current_bid || 0) >= (auction.reserve_price || 0);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      testID={testID}
      style={styles.card}
    >
      <View style={styles.imageWrap}>
        <Image
          source={{ uri: (car.images && car.images[0]) || 'https://images.unsplash.com/photo-1768965468641-39e87aa78a9d?w=1200&q=80' }}
          style={styles.image}
        />
        <View style={styles.imageOverlay} />

        {isLive && (
          <View style={styles.liveBadge}>
            <LivePulse size={6} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        )}
        {auction.status === 'upcoming' && (
          <View style={[styles.statusBadge, { backgroundColor: 'rgba(245,158,11,0.18)', borderColor: colors.warning }]}>
            <Text style={[styles.statusText, { color: colors.warning }]}>UPCOMING</Text>
          </View>
        )}
        {auction.status === 'ended' && (
          <View style={[styles.statusBadge, { backgroundColor: 'rgba(100,116,139,0.18)', borderColor: colors.textMuted }]}>
            <Text style={[styles.statusText, { color: colors.textSecondary }]}>ENDED</Text>
          </View>
        )}

        {onWatch && (
          <Pressable onPress={onWatch} style={styles.heart} hitSlop={10} testID={`${testID}-watch`}>
            <Heart size={18} color={watching ? colors.red : colors.textChrome} fill={watching ? colors.red : 'transparent'} />
          </Pressable>
        )}

        <View style={styles.bottomGradientInfo}>
          <Text style={styles.titleOverlay} numberOfLines={1}>
            {car.year} {car.make} {car.model}
          </Text>
          <Text style={styles.variantOverlay} numberOfLines={1}>
            {car.variant} · {car.color}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.metaRow}>
          <Meta icon={<Calendar size={12} color={colors.textSecondary} />} text={`${car.year || ''}`} />
          <Meta icon={<Gauge size={12} color={colors.textSecondary} />} text={`${(car.km_driven || 0).toLocaleString('en-IN')} km`} />
          <Meta icon={<Fuel size={12} color={colors.textSecondary} />} text={car.fuel_type || ''} />
        </View>

        <View style={styles.priceRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.bidLabel}>{isLive ? 'CURRENT BID' : auction.status === 'upcoming' ? 'STARTING' : 'FINAL BID'}</Text>
            <Text style={styles.bidValue}>{formatINR(auction.current_bid || auction.starting_bid)}</Text>
          </View>
          <View style={styles.timerWrap}>
            {isLive ? (
              <CountdownTimer endTime={auction.end_time} compact />
            ) : auction.status === 'upcoming' ? (
              <Text style={styles.timerCompactMuted}>Starts soon</Text>
            ) : (
              <Text style={styles.timerCompactMuted}>{auction.total_bids} bids</Text>
            )}
          </View>
        </View>

        <View style={styles.footerRow}>
          <View style={styles.scorePill}>
            <Text style={styles.scoreLabel}>INSPECTION</Text>
            <Text style={styles.scoreVal}>{(car.inspection_score || 0).toFixed(1)}/10</Text>
          </View>
          <View style={[styles.scorePill, reserveMet ? styles.reserveMet : styles.reserveNotMet]}>
            <Text style={[styles.scoreLabel, reserveMet ? { color: colors.success } : { color: colors.warning }]}>
              {reserveMet ? 'RESERVE MET' : 'RESERVE'}
            </Text>
          </View>
          <View style={styles.scorePill}>
            <Text style={styles.scoreLabel}>BIDS</Text>
            <Text style={styles.scoreVal}>{auction.total_bids || 0}</Text>
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
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  imageWrap: { width: '100%', height: 200, position: 'relative', backgroundColor: '#000' },
  image: { width: '100%', height: '100%' },
  imageOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 90, backgroundColor: 'rgba(11,11,13,0.85)' },
  liveBadge: {
    position: 'absolute', top: 14, left: 14,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.red, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999,
  },
  liveText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  statusBadge: {
    position: 'absolute', top: 14, left: 14,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, borderWidth: 1,
  },
  statusText: { fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  heart: {
    position: 'absolute', top: 12, right: 12,
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(11,11,13,0.7)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(203,213,225,0.15)',
  },
  bottomGradientInfo: { position: 'absolute', bottom: 12, left: 14, right: 14 },
  titleOverlay: { color: colors.textPrimary, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  variantOverlay: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  body: { padding: spacing.lg },
  metaRow: { flexDirection: 'row', gap: spacing.lg, marginBottom: spacing.md },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: { color: colors.textSecondary, fontSize: 12 },

  priceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  bidLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.4, marginBottom: 4 },
  bidValue: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  timerWrap: { alignItems: 'flex-end' },
  timerCompactMuted: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },

  footerRow: { flexDirection: 'row', gap: 8 },
  scorePill: {
    flex: 1, backgroundColor: colors.bg,
    borderRadius: 10, paddingVertical: 8, paddingHorizontal: 8,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center',
  },
  reserveMet: { borderColor: 'rgba(16,185,129,0.3)', backgroundColor: 'rgba(16,185,129,0.05)' },
  reserveNotMet: { borderColor: 'rgba(245,158,11,0.25)', backgroundColor: 'rgba(245,158,11,0.04)' },
  scoreLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  scoreVal: { color: colors.textChrome, fontSize: 13, fontWeight: '700', marginTop: 2 },
});
