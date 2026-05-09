import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Dimensions,
  ActivityIndicator, Modal, Platform,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import Animated, { useSharedValue, useAnimatedStyle, withSequence, withTiming, withDelay } from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ZoomGallery } from '../../src/components/ZoomGallery';
import {
  ArrowLeft, Heart, Share2, Trophy, ShieldCheck, AlertTriangle, Activity,
  Calendar, Gauge, Fuel, Settings2, Users, ChevronRight, Eye, Lock,
  X, ImageIcon,
} from 'lucide-react-native';
import { colors, formatINR, formatINRFull, maskRegNo, radii } from '../../src/theme';
import { api, wsUrl } from '../../src/api';
import { useAuth } from '../../src/auth';
import { CountdownTimer } from '../../src/components/CountdownTimer';
import { LivePulse } from '../../src/components/LivePulse';
import { InspectionPdfCard } from '../../src/components/InspectionPdfCard';
import { useToast } from '../../src/toast';
import { SECTIONS, SECTION_LABELS, SectionKey, absUrl } from '../../src/media';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = 360;

export default function AuctionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, fb } = useLocalSearchParams<{ id: string; fb?: string }>();
  const { dealer } = useAuth();
  const toast = useToast();

  const [auction, setAuction] = useState<any>(null);
  const [bids, setBids] = useState<any[]>([]);
  const [feedToast, setFeedToast] = useState<string | null>(null);
  const [imgIdx, setImgIdx] = useState(0);
  const [watching, setWatching] = useState(false);
  const [media, setMedia] = useState<any[]>([]);
  const [galleryFilter, setGalleryFilter] = useState<SectionKey | 'all'>('all');
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomStartIdx, setZoomStartIdx] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  // Track-view fires once per mount per auction id.
  const trackedRef = useRef<string | null>(null);

  const bidPulse = useSharedValue(1);
  const outbidFlash = useSharedValue(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const a: any = await api.auction(id as string);
      setAuction(a);
      setBids(a.recent_bids || []);
      // Fetch sectioned media (uses GridFS or external auto-migration)
      if (a?.car?.id) {
        try {
          const mm = await api.carMedia(a.car.id);
          setMedia(mm as any[]);
        } catch {}
      }
      // Check watchlist
      const w: any[] = await api.watchlist().catch(() => []);
      setWatching(!!w.find((x) => x.id === a.id));
    } catch (e: any) {
      toast.show(e.message || 'Failed to load auction', 'error');
    }
  }, [id, toast]);

  // Derived gallery (filtered by section). Falls back to legacy car.images if
  // /media is empty (e.g. very fresh install before auto-migration ran).
  const galleryItems = useMemo(() => {
    const list = (media && media.length > 0) ? media : [];
    if (list.length === 0 && auction?.car?.images) {
      return (auction.car.images as string[]).map((url, i) => ({ id: `legacy_${i}`, section: 'exterior', url, thumb_url: url }));
    }
    return galleryFilter === 'all' ? list : list.filter((m: any) => m.section === galleryFilter);
  }, [media, auction?.car?.images, galleryFilter]);

  const galleryUrls = useMemo(
    () => galleryItems.map((m: any) => absUrl(m.url || m.thumb_url)),
    [galleryItems],
  );

  const heroUri = galleryUrls[Math.min(imgIdx, Math.max(0, galleryUrls.length - 1))];

  // Reset image index when filter changes
  useEffect(() => { setImgIdx(0); }, [galleryFilter]);

  // Silent funnel tracking — fires once per auction-id mount. The
  // optional `fb` query param carries explicit broadcast deep-link
  // attribution; backend falls back to recent-broadcast lookup when
  // omitted. Failures are swallowed so the lot screen never blocks.
  useEffect(() => {
    if (!id || !dealer) return;
    if (trackedRef.current === id) return;
    trackedRef.current = id as string;
    api.auctionTrackView(id as string, (fb as string) || undefined).catch(() => {});
  }, [id, fb, dealer]);

  const sectionsAvailable = useMemo(() => {
    const set = new Set<string>(media.map((m: any) => m.section));
    return SECTIONS.filter((s) => set.has(s));
  }, [media]);

  const openZoom = (idx: number) => {
    setZoomStartIdx(idx);
    setZoomOpen(true);
  };

  // WebSocket — authenticated handshake (token attached as query param).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    (async () => {
      try {
        const url = await wsUrl(id as string);
        if (cancelled) return;
        ws = new WebSocket(url);
        wsRef.current = ws;
        ws.onopen = () => {};
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'session_killed') {
              // Server kicked us — token_version drift. Bounce to login.
              try { ws?.close(); } catch {}
              return;
            }
            handleWsMessage(msg);
          } catch {}
        };
      } catch {}
    })();
    return () => {
      cancelled = true;
      try { ws?.close(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleWsMessage = (msg: any) => {
        if (msg.type === 'snapshot') {
          setAuction(msg.auction);
        } else if (msg.type === 'new_bid') {
          setAuction((prev: any) => prev ? {
            ...prev,
            current_bid: msg.current_bid,
            top_bidder_id: msg.top_bidder_id,
            top_bidder_name: msg.top_bidder_name,
            total_bids: msg.total_bids,
          } : prev);
          setBids((prev) => [msg.bid, ...prev].slice(0, 20));
          // pulse animation
          bidPulse.value = withSequence(
            withTiming(1.06, { duration: 180 }),
            withTiming(1, { duration: 220 })
          );
          // toast for outbid if I'm not the new top bidder
          if (dealer && msg.top_bidder_id !== dealer.id) {
            const outbidByOther = bids[0]?.dealer_id === dealer.id;
            if (outbidByOther) {
              outbidFlash.value = withSequence(withTiming(1, { duration: 200 }), withDelay(1400, withTiming(0, { duration: 400 })));
              setFeedToast('You have been outbid!');
              try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
              setTimeout(() => setFeedToast(null), 2200);
            }
          }
        }
  };

  const placeBid = async (amount: number) => {
    try {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
      await api.bid(id as string, amount);
      toast.show(`Bid placed at ${formatINR(amount)}`, 'success');
    } catch (e: any) {
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
      const msg = String(e?.message || '');
      if (msg.includes('BID_EXCEEDS_DEALER_LIMIT')) {
        toast.show('Bid exceeds approved dealer limit.', 'error');
      } else if (msg.includes('DEALER_PENDING_APPROVAL')) {
        toast.show('Bidding activates after Q Drives approves your account.', 'error');
      } else if (msg.includes('DEALER_ACCOUNT_SUSPENDED')) {
        toast.show('Account suspended. Contact Q Drives support.', 'error');
      } else if (msg.includes('DEALER_ACCOUNT_REVOKED')) {
        toast.show('Account access has been revoked.', 'error');
      } else {
        toast.show(msg || 'Bid failed', 'error');
      }
    }
  };

  const toggleWatch = async () => {
    setWatching((w) => !w);
    try {
      if (watching) {
        await api.removeWatch(id as string);
        toast.show('Removed from watchlist', 'info');
      } else {
        await api.addWatch(id as string);
        toast.show('Added to watchlist', 'success');
      }
    } catch {
      setWatching((w) => !w);
    }
  };

  const bidPulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: bidPulse.value }] }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: outbidFlash.value }));

  if (!auction) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 6, alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.red} />
        <Text style={{ color: colors.textMuted, marginTop: 14, fontSize: 12, fontWeight: '700', letterSpacing: 1.5 }}>LOADING AUCTION</Text>
      </View>
    );
  }

  const car = auction.car || {};
  const isLive = auction.status === 'live';
  const reserveMet = (auction.current_bid || 0) >= (auction.reserve_price || 0);
  const isWinning = dealer && auction.top_bidder_id === dealer.id;
  const minIncrement = 5000;
  const nextBid1 = (auction.current_bid || 0) + minIncrement;
  const nextBid2 = (auction.current_bid || 0) + minIncrement * 4;
  const nextBid3 = (auction.current_bid || 0) + minIncrement * 10;
  const isOwn = dealer && dealer.id === auction.seller_id;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 6 }]}>
      {/* Outbid flash overlay */}
      <Animated.View style={[styles.outbidFlash, flashStyle, { pointerEvents: 'none' }]}>
        <View style={styles.outbidContent}>
          <AlertTriangle size={20} color="#fff" />
          <Text style={styles.outbidText}>{feedToast}</Text>
        </View>
      </Animated.View>

      <ScrollView contentContainerStyle={{ paddingBottom: 220 }}>
        {/* Hero gallery */}
        <View style={styles.hero}>
          <TouchableOpacity activeOpacity={0.95} onPress={() => galleryUrls.length > 0 && openZoom(imgIdx)}>
            <Image source={{ uri: heroUri }} style={styles.heroImg} contentFit="cover" transition={180} cachePolicy="memory-disk" />
          </TouchableOpacity>
          <View style={styles.heroGradient} />

          <View style={[styles.heroTop, { paddingTop: 8 }]}>
            <TouchableOpacity onPress={() => router.back()} style={styles.iconRound} testID="auction-back">
              <ArrowLeft size={20} color={colors.textPrimary} />
            </TouchableOpacity>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={toggleWatch} style={styles.iconRound} testID="auction-watch">
                <Heart size={18} color={watching ? colors.red : colors.textPrimary} fill={watching ? colors.red : 'transparent'} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconRound}>
                <Share2 size={18} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.heroBadgeRow}>
            {isLive && (
              <View style={styles.heroLiveBadge}>
                <LivePulse size={6} />
                <Text style={styles.heroLiveText}>LIVE AUCTION</Text>
              </View>
            )}
            {isLive && (
              <View style={styles.heroViewers}>
                <Eye size={11} color={colors.textChrome} />
                <Text style={styles.heroViewersText}>{auction.interested_dealers || 0} dealers watching</Text>
              </View>
            )}
            {galleryUrls.length > 0 && (
              <View style={styles.heroPhotoCount}>
                <ImageIcon size={11} color={colors.textChrome} />
                <Text style={styles.heroPhotoCountText}>{imgIdx + 1}/{galleryUrls.length}</Text>
              </View>
            )}
          </View>

          {/* Title overlay */}
          <View style={styles.heroBottom}>
            <Text style={styles.heroTitle}>{car.year} {car.make} {car.model}</Text>
            <Text style={styles.heroVariant}>{car.variant} · {car.color}</Text>
            <View style={styles.regPlate}>
              <Text style={styles.regText}>{maskRegNo(car.registration_number)}</Text>
            </View>
          </View>
        </View>

        {/* Section filter tabs */}
        {sectionsAvailable.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.galleryTabs}>
            <TouchableOpacity
              onPress={() => setGalleryFilter('all')}
              style={[styles.gTab, galleryFilter === 'all' && styles.gTabActive]}
            >
              <Text style={[styles.gTabText, galleryFilter === 'all' && styles.gTabTextActive]}>
                All · {media.length || (auction?.car?.images?.length || 0)}
              </Text>
            </TouchableOpacity>
            {sectionsAvailable.map((s) => {
              const count = media.filter((m: any) => m.section === s).length;
              const active = galleryFilter === s;
              return (
                <TouchableOpacity
                  key={s}
                  onPress={() => setGalleryFilter(s)}
                  style={[styles.gTab, active && styles.gTabActive]}
                  testID={`gallery-tab-${s}`}
                >
                  <Text style={[styles.gTabText, active && styles.gTabTextActive]}>
                    {SECTION_LABELS[s]} · {count}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* Thumbnail strip — lazy via expo-image */}
        {galleryItems.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbStrip}>
            {galleryItems.map((m: any, i: number) => (
              <TouchableOpacity
                key={m.id || i}
                onPress={() => setImgIdx(i)}
                onLongPress={() => openZoom(i)}
                style={[styles.thumbBox, imgIdx === i && styles.thumbBoxActive]}
              >
                <Image
                  source={{ uri: absUrl(m.thumb_url || m.url) }}
                  style={styles.thumb}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Status banner */}
        {isWinning && (
          <View style={[styles.statusBanner, styles.winningBanner]}>
            <Trophy size={18} color={colors.success} />
            <Text style={[styles.bannerText, { color: colors.success }]}>You are winning this auction</Text>
          </View>
        )}
        {isOwn && (
          <View style={[styles.statusBanner, { backgroundColor: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.3)' }]}>
            <Activity size={18} color={colors.warning} />
            <Text style={[styles.bannerText, { color: colors.warning }]}>This is your listing — bidding disabled</Text>
          </View>
        )}

        {/* Specs grid */}
        <View style={styles.specsGrid}>
          <Spec icon={<Calendar size={14} color={colors.textChrome} />} label="Year" value={`${car.year}`} />
          <Spec icon={<Gauge size={14} color={colors.textChrome} />} label="KMs" value={`${(car.km_driven || 0).toLocaleString('en-IN')}`} />
          <Spec icon={<Fuel size={14} color={colors.textChrome} />} label="Fuel" value={car.fuel_type} />
          <Spec icon={<Settings2 size={14} color={colors.textChrome} />} label="Trans." value={car.transmission} />
          <Spec icon={<Users size={14} color={colors.textChrome} />} label="Owners" value={`${car.owners}`} />
          <Spec icon={<ShieldCheck size={14} color={colors.success} />} label="RC" value={car.rc_verified ? 'Verified' : 'Pending'} />
        </View>

        {/* Score cards — note: MARGIN EST. removed pending real backend
            valuation logic (acquisition + reconditioning + fees + resale).
            Will reintroduce once the calc lives in /api/admin/inventory. */}
        <View style={styles.scoreRow}>
          <ScoreCard label="INSPECTION" value={`${(car.inspection_score || 0).toFixed(1)}/10`} accent={colors.success} />
          <ScoreCard label="LIQUIDITY" value="HIGH" accent={colors.warning} />
        </View>

        {/* Trust strip — escrow / settlement copy removed per ops policy
            (avoid promising commercial guarantees we don't enforce in
            v1). Keep RC verification + inspection PDF surface. */}
        <View style={styles.trustStrip}>
          <View style={styles.trustItem}>
            <ShieldCheck size={13} color={colors.success} />
            <Text style={styles.trustItemText}>RC verified</Text>
          </View>
          {auction.inspection_pdf && (
            <>
              <View style={styles.trustDivider} />
              <View style={styles.trustItem}>
                <ShieldCheck size={13} color={colors.success} />
                <Text style={[styles.trustItemText, { color: colors.success }]}>PDF report</Text>
              </View>
            </>
          )}
        </View>

        {/* Inspection summary (highlights + PDF) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Inspection Summary</Text>
          <View style={styles.detailCard}>
            <DetailRow label="Condition grade" value={car.condition_grade || 'A'} valueColor={colors.success} />
            <DetailRow label="Tyre condition" value={car.tyre_condition || 'Good'} />
            <DetailRow label="Accident history" value={car.accident_history || 'None Reported'} valueColor={(car.accident_history || '').includes('None') ? colors.success : colors.warning} />
            <DetailRow label="Service history" value={car.service_history || 'Authorised'} />
          </View>

          <View style={{ marginTop: 12 }}>
            <InspectionPdfCard inspection={auction.inspection_pdf} />
          </View>
        </View>

        {/* Reserve & price band */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pricing</Text>
          <View style={styles.detailCard}>
            <DetailRow label="Starting bid" value={formatINR(auction.starting_bid)} />
            <DetailRow label="Reserve price" value={formatINR(auction.reserve_price)} />
            <DetailRow label="Reserve status" value={reserveMet ? 'MET' : 'NOT MET'} valueColor={reserveMet ? colors.success : colors.warning} />
            <DetailRow label="Total bids" value={`${auction.total_bids || 0}`} />
            <DetailRow label="Watching" value={`${auction.interested_dealers || 0} dealers`} />
          </View>
        </View>

        {/* Live bid feed */}
        <View style={styles.section}>
          <View style={styles.feedHeader}>
            <Text style={styles.sectionTitle}>Live bid feed</Text>
            {isLive && <LivePulse size={6} />}
          </View>
          <View style={styles.detailCard}>
            {bids.length === 0 ? (
              <Text style={styles.empty}>No bids yet — be the first.</Text>
            ) : bids.slice(0, 8).map((b, i) => (
              <View key={b.id || i} style={styles.bidRow}>
                <View style={[styles.bidAvatar, b.dealer_id === dealer?.id && { backgroundColor: colors.red }]}>
                  <Text style={styles.bidAvatarText}>{(b.dealer_name || 'D').charAt(0)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bidName} numberOfLines={1}>
                    {b.dealer_id === dealer?.id ? 'You' : b.dealer_name}
                  </Text>
                  <Text style={styles.bidTime}>{i === 0 ? 'just now' : `${i * 2 + 1}m ago`}</Text>
                </View>
                <Text style={[styles.bidAmt, i === 0 && { color: colors.red }]}>{formatINR(b.amount)}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Seller */}
        {auction.seller && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Seller</Text>
            <View style={styles.detailCard}>
              <View style={styles.sellerRow}>
                <View style={styles.sellerAvatar}><Text style={styles.bidAvatarText}>{auction.seller.dealership_name?.charAt(0) || 'S'}</Text></View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.sellerName}>{auction.seller.dealership_name || 'Verified Dealer'}</Text>
                    {auction.seller.verified && <ShieldCheck size={14} color={colors.success} />}
                  </View>
                  <Text style={styles.sellerCity}>{auction.seller.city}</Text>
                </View>
                <ChevronRight size={16} color={colors.textMuted} />
              </View>
            </View>
          </View>
        )}

        {/* Raise Dispute — visible to anyone who has bid or won. Lean: links to
            the my-disputes screen with auction_id pre-populated. */}
        {!isOwn && (
          <TouchableOpacity
            onPress={() => router.push({ pathname: '/my-disputes', params: { raise: '1', auction_id: auction.id } } as any)}
            style={styles.raiseDisputeBtn}
            activeOpacity={0.75}
            testID="auction-raise-dispute">
            <AlertTriangle size={14} color={colors.textMuted} />
            <Text style={styles.raiseDisputeTxt}>RAISE DISPUTE ON THIS LOT</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Sticky bid module */}
      <View style={[styles.bidModule, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.bidTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.currentLabel}>{isLive ? 'CURRENT BID' : auction.status === 'upcoming' ? 'STARTING' : 'FINAL'}</Text>
            <Animated.Text style={[styles.currentBid, bidPulseStyle, isWinning && { color: colors.success }]} testID="auction-current-bid">
              {formatINRFull(auction.current_bid || auction.starting_bid)}
            </Animated.Text>
            <Text style={styles.topBidder}>
              {auction.top_bidder_name ? `Top: ${auction.top_bidder_id === dealer?.id ? 'You' : auction.top_bidder_name}` : 'No bids yet'} · {auction.total_bids} bids
            </Text>
          </View>
          {isLive ? <CountdownTimer endTime={auction.end_time} /> : (
            <Text style={[styles.endedTxt, auction.status === 'ended' && { color: colors.textMuted }]}>{auction.status === 'upcoming' ? 'Soon' : 'Ended'}</Text>
          )}
        </View>

        {isLive && !isOwn && dealer?.status === 'approved' && (
          <View style={styles.bidButtons}>
            <BidButton amount={nextBid1} onPress={() => placeBid(nextBid1)} testID="bid-min" />
            <BidButton amount={nextBid2} onPress={() => placeBid(nextBid2)} highlighted testID="bid-mid" />
            <BidButton amount={nextBid3} onPress={() => placeBid(nextBid3)} testID="bid-max" />
          </View>
        )}
        {isLive && !isOwn && dealer && dealer.status !== 'approved' && (
          <View style={styles.lockedCta} testID="bid-locked-pending">
            <View style={styles.lockedRow}>
              <Lock size={13} color={colors.warning} strokeWidth={2.4} />
              <Text style={styles.lockedKicker}>
                {dealer.status === 'pending' ? 'PENDING APPROVAL'
                  : dealer.status === 'suspended' ? 'ACCOUNT SUSPENDED'
                  : 'ACCESS RESTRICTED'}
              </Text>
            </View>
            <Text style={styles.lockedBody}>
              {dealer.status === 'pending'
                ? 'Bidding activates once Q Drives approves your account. You can browse and watchlist in the meantime.'
                : dealer.status === 'suspended'
                ? 'Your account is suspended. Contact Q Drives support to restore bidding.'
                : 'Bidding is currently restricted on your account.'}
            </Text>
          </View>
        )}
        {!isLive && (
          <View style={styles.disabledCta}>
            <Text style={styles.disabledCtaText}>{auction.status === 'upcoming' ? 'Auction starts soon' : 'Auction ended'}</Text>
          </View>
        )}
      </View>

      {/* Fullscreen pinch-zoom gallery */}
      <Modal visible={zoomOpen} transparent={false} animationType="fade" onRequestClose={() => setZoomOpen(false)}>
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
          <View style={styles.zoomTopBar}>
            <TouchableOpacity onPress={() => setZoomOpen(false)} style={styles.zoomCloseBtn}>
              <X size={22} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <View style={styles.zoomCounter}>
              <Text style={styles.zoomCounterText}>{(zoomStartIdx + 1)} / {galleryUrls.length}</Text>
            </View>
          </View>
          {galleryUrls.length > 0 && (
            <ZoomGallery
              uris={galleryUrls}
              initialIndex={zoomStartIdx}
              onIndexChange={(i) => setZoomStartIdx(i)}
              onClose={() => setZoomOpen(false)}
            />
          )}
        </GestureHandlerRootView>
      </Modal>
    </View>
  );
}

function BidButton({ amount, onPress, highlighted, testID }: { amount: number; onPress: () => void; highlighted?: boolean; testID?: string }) {
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} testID={testID} style={[styles.bidBtn, highlighted && styles.bidBtnHi]}>
      <Text style={[styles.bidBtnLabel, highlighted && { color: '#fff' }]}>BID</Text>
      <Text style={[styles.bidBtnAmount, highlighted && { color: '#fff' }]}>{formatINR(amount)}</Text>
    </TouchableOpacity>
  );
}

function Spec({ icon, label, value }: any) {
  return (
    <View style={styles.specCell}>
      <View style={styles.specIconRow}>{icon}<Text style={styles.specLabel}>{label}</Text></View>
      <Text style={styles.specValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function ScoreCard({ label, value, accent }: any) {
  return (
    <View style={styles.scoreCard}>
      <Text style={[styles.scoreLabel, { color: accent }]}>{label}</Text>
      <Text style={styles.scoreValue}>{value}</Text>
    </View>
  );
}

function DetailRow({ label, value, valueColor }: any) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  outbidFlash: {
    position: 'absolute', top: 60, left: 0, right: 0, zIndex: 100,
    alignItems: 'center', pointerEvents: 'none',
  },
  outbidContent: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.red, paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: 999,
    shadowColor: colors.red, shadowOpacity: 0.6, shadowRadius: 16, elevation: 12,
  },
  outbidText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  raiseDisputeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginHorizontal: 16, marginTop: 16, paddingVertical: 12,
    borderRadius: 6, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  raiseDisputeTxt: {
    color: colors.textMuted, fontSize: 11, fontWeight: '900', letterSpacing: 0.7,
  },

  hero: { width: '100%', height: HERO_H, backgroundColor: '#000', position: 'relative' },
  heroImg: { width: '100%', height: '100%' },
  heroGradient: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(11,11,13,0.5)' },
  heroTop: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingHorizontal: 16, paddingTop: 14,
    flexDirection: 'row', justifyContent: 'space-between',
  },
  iconRound: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(11,11,13,0.6)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  heroBadgeRow: { position: 'absolute', top: 70, left: 16, right: 16, flexDirection: 'row', gap: 8, alignItems: 'center' },
  heroLiveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.red, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  heroLiveText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  heroViewers: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: 'rgba(11,11,13,0.65)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  heroViewersText: { color: colors.textChrome, fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  dots: { position: 'absolute', top: HERO_H / 2 - 6, alignSelf: 'center', flexDirection: 'row', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.3)' },
  dotActive: { backgroundColor: colors.red, width: 14 },
  heroBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20 },
  heroTitle: { color: colors.textPrimary, fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  heroVariant: { color: colors.textChrome, fontSize: 13, marginTop: 4 },
  regPlate: { alignSelf: 'flex-start', marginTop: 10, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: 6 },
  regText: { color: '#0B0B0D', fontSize: 12, fontWeight: '900', letterSpacing: 1.5 },

  statusBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 20, marginTop: 16, padding: 14,
    backgroundColor: 'rgba(16,185,129,0.08)', borderColor: 'rgba(16,185,129,0.3)', borderWidth: 1,
    borderRadius: radii.md,
  },
  winningBanner: {},
  bannerText: { fontSize: 13, fontWeight: '800' },

  specsGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, marginTop: 16, gap: 6 },
  specCell: { width: (SCREEN_W - 36) / 3, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 10 },
  specIconRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  specLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  specValue: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },

  trustStrip: { marginHorizontal: 20, marginTop: 14, padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md },
  trustItem: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  trustItemText: { color: colors.textChrome, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  trustDivider: { width: StyleSheet.hairlineWidth, height: 24, backgroundColor: colors.border },

  scoreRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginTop: 16 },
  scoreCard: { flex: 1, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 12 },
  scoreLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  scoreValue: { color: colors.textPrimary, fontSize: 17, fontWeight: '800', marginTop: 4 },

  section: { paddingHorizontal: 20, marginTop: 24 },
  sectionTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', marginBottom: 10, letterSpacing: -0.2 },
  detailCard: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 16 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  detailLabel: { color: colors.textSecondary, fontSize: 13 },
  detailValue: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  empty: { color: colors.textMuted, fontSize: 13, paddingVertical: 8 },

  feedHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  bidRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  bidAvatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  bidAvatarText: { color: colors.textPrimary, fontWeight: '800', fontSize: 12 },
  bidName: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  bidTime: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  bidAmt: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },

  sellerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sellerAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sellerName: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  sellerCity: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },

  bidModule: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    borderTopColor: colors.border, borderTopWidth: 1,
    padding: 18, paddingTop: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: -10 }, shadowOpacity: 0.6, shadowRadius: 24, elevation: 20,
  },
  bidTop: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 14 },
  currentLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  currentBid: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', letterSpacing: -0.5, marginTop: 2 },
  topBidder: { color: colors.textSecondary, fontSize: 11, marginTop: 4 },
  endedTxt: { color: colors.warning, fontSize: 14, fontWeight: '800', letterSpacing: 1.2 },

  bidButtons: { flexDirection: 'row', gap: 8 },
  bidBtn: {
    flex: 1, paddingVertical: 12, borderRadius: radii.md,
    alignItems: 'center', backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
  },
  bidBtnHi: {
    backgroundColor: colors.red, borderColor: colors.red,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.5, shadowRadius: 12, elevation: 8,
  },
  bidBtnLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.4 },
  bidBtnAmount: { color: colors.textPrimary, fontSize: 15, fontWeight: '800', marginTop: 2, letterSpacing: -0.3 },

  disabledCta: { backgroundColor: colors.bgCard, paddingVertical: 14, borderRadius: radii.md, alignItems: 'center' },
  disabledCtaText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  lockedCta: { backgroundColor: 'rgba(245,158,11,0.06)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.40)', paddingVertical: 12, paddingHorizontal: 14, borderRadius: radii.md },
  lockedRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 },
  lockedKicker: { color: colors.warning, fontSize: 11, fontWeight: '900', letterSpacing: 1.4 },
  lockedBody: { color: colors.textChrome, fontSize: 12, fontWeight: '600', lineHeight: 16 },

  // Gallery additions
  heroPhotoCount: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  heroPhotoCountText: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },

  galleryTabs: { gap: 8, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  gTab: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 },
  gTabActive: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: colors.red },
  gTabText: { color: colors.textChrome, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  gTabTextActive: { color: colors.red },

  thumbStrip: { gap: 8, paddingHorizontal: 20, paddingVertical: 10 },
  thumbBox: { width: 70, height: 50, borderRadius: 6, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  thumbBoxActive: { borderColor: colors.red },
  thumb: { width: '100%', height: '100%', backgroundColor: '#000' },

  zoomTopBar: { position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 0, right: 0, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', zIndex: 10 },
  zoomCloseBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  zoomCounter: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.10)', borderRadius: 999 },
  zoomCounterText: { color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 1.4 },
});
