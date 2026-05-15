/**
 * Q Drives — Admin Media Manager
 *
 * Per-vehicle photo manager with sectioned tabs, multi-image upload (with
 * client-side compression + per-item progress + auto-retry), drag-and-drop
 * reorder, featured-thumbnail picker, delete + change-section menu, and
 * mandatory-section completeness checklist.
 *
 * Available only to admin (Q Drives) users via /inventory/[carId]/media.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  Alert, Modal, Pressable, Dimensions, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter, Redirect, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, { ScaleDecorator, RenderItemParams } from 'react-native-draggable-flatlist';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import {
  ArrowLeft, ImagePlus, Star, Trash2, Move, CheckCircle2, AlertCircle,
  Upload as UploadIcon, X, ChevronDown, ShieldAlert, ShieldCheck, Rocket,
} from 'lucide-react-native';
import { colors, radii } from '../../../src/theme';
import { api } from '../../../src/api';
import { useAuth } from '../../../src/auth';
import { useToast } from '../../../src/toast';
import {
  SECTIONS, SECTION_LABELS, SECTION_HINTS, MANDATORY_MIN, MAX_PER_CAR,
  SectionKey, compressForUpload, uploadMediaXhr, absUrl,
} from '../../../src/media';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const TILE_GAP = 8;
const TILES_PER_ROW = 3;
const TILE_SIZE = Math.floor((SCREEN_WIDTH - 40 - TILE_GAP * (TILES_PER_ROW - 1)) / TILES_PER_ROW);

type Media = any;

type PendingUpload = {
  localId: string;
  uri: string;
  section: SectionKey;
  pct: number;
  status: 'queued' | 'compressing' | 'uploading' | 'done' | 'error';
  error?: string;
};

export default function MediaManager() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ carId: string; auctionId?: string }>();
  const carId = params.carId as string;
  const auctionIdParam = (params.auctionId as string) || null;
  const toast = useToast();
  const { dealer } = useAuth();

  if (dealer && !['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(dealer.role as any)) {
    return <Redirect href="/(tabs)/" />;
  }

  const [activeSection, setActiveSection] = useState<SectionKey>('exterior');
  const [media, setMedia] = useState<Media[]>([]);
  const [completeness, setCompleteness] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [moveTarget, setMoveTarget] = useState<Media | null>(null);

  // ---- Draft / launch state ----
  // If we don't get auctionId via query params (e.g. user landed here from
  // my-listings or by deep-link), discover it by scanning auctions filtered
  // by car_id. We keep the discovered id in local state so the Launch CTA
  // can use it.
  const [auctionId, setAuctionId] = useState<string | null>(auctionIdParam);
  const [auctionStatus, setAuctionStatus] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<{
    ready: boolean; issues: string[]; media_count: number; featured_count: number; min_photos_required: number;
  } | null>(null);
  const [launching, setLaunching] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([
        api.carMedia(carId),
        api.mediaCompleteness(carId).catch(() => null),
      ]);
      setMedia(m as any[]);
      setCompleteness(c);

      // Discover auction id by car_id if not passed in via query params.
      // This is what enables the Launch button when an operator arrives
      // here via my-listings → "Manage gallery".
      let aid = auctionId;
      if (!aid) {
        try {
          // Operator-scoped fetch — includes drafts (the marketplace
          // filter would strip them out).
          const all: any[] = await api.auctions(undefined, 'me');
          const match = all.find((x) => x?.car?.id === carId || x?.car_id === carId);
          if (match) aid = match.id;
          if (aid) setAuctionId(aid);
        } catch {}
      }
      // Pull launch-readiness only for draft auctions (operator-only API)
      if (aid) {
        try {
          const r: any = await api.launchReadiness(aid);
          setReadiness({
            ready: !!r.ready,
            issues: r.issues || [],
            media_count: r.media_count || 0,
            featured_count: r.featured_count || 0,
            min_photos_required: r.min_photos_required || 3,
          });
          setAuctionStatus(r.status || null);
        } catch {
          // Endpoint 404s or returns 422 on already-live/closed auctions;
          // we simply hide the Launch CTA in that case.
          setReadiness(null);
          setAuctionStatus(null);
        }
      }
    } catch (e: any) {
      toast.show(e.message || 'Failed to load media', 'error');
    } finally {
      setLoading(false);
    }
  }, [carId, auctionId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // --- Upload pipeline ---
  const pickAndUpload = async () => {
    const totalCount = media.length + pending.filter((p) => p.status !== 'error').length;
    if (totalCount >= MAX_PER_CAR) {
      toast.show(`Max ${MAX_PER_CAR} images per vehicle. Delete some first.`, 'error');
      return;
    }
    const remaining = MAX_PER_CAR - totalCount;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (perm.status !== 'granted') {
      toast.show('Photo library permission denied', 'error');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: Math.min(remaining, 20),
      quality: 1,
      exif: false,
    });
    if (res.canceled) return;
    const assets = res.assets || [];
    const queue: PendingUpload[] = assets.map((a) => ({
      localId: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      uri: a.uri,
      section: activeSection,
      pct: 0,
      status: 'queued',
    }));
    setPending((p) => [...p, ...queue]);
    // Process sequentially to keep things stable on slow networks (and so
    // the order matches the user's selection)
    for (const item of queue) {
      await processUpload(item);
    }
    // Refresh from server once batch is done
    load();
  };

  const processUpload = async (item: PendingUpload) => {
    setPending((p) => p.map((x) => (x.localId === item.localId ? { ...x, status: 'compressing' } : x)));
    try {
      const compressed = await compressForUpload(item.uri);
      setPending((p) => p.map((x) => (x.localId === item.localId ? { ...x, status: 'uploading' } : x)));
      await uploadMediaXhr({
        carId,
        section: item.section,
        fullUri: compressed.fullUri,
        thumbUri: compressed.thumbUri,
        width: compressed.width,
        height: compressed.height,
        onProgress: ({ pct }) => {
          setPending((p) => p.map((x) => (x.localId === item.localId ? { ...x, pct } : x)));
        },
      });
      setPending((p) => p.map((x) => (x.localId === item.localId ? { ...x, status: 'done', pct: 1 } : x)));
      // Drop the success record after a short visual confirmation
      setTimeout(() => {
        setPending((p) => p.filter((x) => x.localId !== item.localId));
      }, 600);
    } catch (e: any) {
      // Always extract a readable string. `e.message` is already formatted
      // by uploadOnce's formatErrorDetail(), but if something else
      // throws (e.g. compressForUpload) we still want a clean toast
      // instead of "[object Object]".
      const friendly = typeof e?.message === 'string' && e.message
        ? e.message
        : (typeof e === 'string' ? e : 'try again');
      setPending((p) => p.map((x) => (x.localId === item.localId ? { ...x, status: 'error', error: friendly } : x)));
      console.error('[media.upload] failed', { section: item.section, uri: item.uri, err: e });
      toast.show(`Upload failed: ${friendly}`, 'error');
    }
  };

  const retryFailed = (localId: string) => {
    const item = pending.find((p) => p.localId === localId);
    if (!item) return;
    processUpload(item);
  };

  // --- Mutations ---
  const onDelete = (m: Media) => {
    Alert.alert(
      'Delete photo?', 'This cannot be undone.',
      [{ text: 'Cancel', style: 'cancel' },
       { text: 'Delete', style: 'destructive', onPress: async () => {
          try { await api.deleteMedia(m.id); toast.show('Photo deleted', 'success'); load(); }
          catch (e: any) { toast.show(e.message || 'Delete failed', 'error'); }
       }}],
    );
  };

  const onSetFeatured = async (m: Media) => {
    if (m.is_featured) return;
    try {
      await api.setFeaturedMedia(carId, m.id);
      toast.show('Featured thumbnail updated', 'success');
      load();
    } catch (e: any) { toast.show(e.message || 'Could not set featured', 'error'); }
  };

  const onChangeSection = async (m: Media, target: SectionKey) => {
    setMoveTarget(null);
    if (m.section === target) return;
    try {
      await api.patchMedia(m.id, { section: target });
      toast.show(`Moved to ${SECTION_LABELS[target]}`, 'success');
      load();
    } catch (e: any) { toast.show(e.message || 'Move failed', 'error'); }
  };

  const onReorder = async (newOrder: Media[]) => {
    // Optimistically apply order
    const sectionItems = newOrder;
    const others = media.filter((m) => m.section !== activeSection);
    setMedia([...others, ...sectionItems]);
    try {
      // Persist global order = others (kept) + sectionItems (new order in this section).
      // Backend rewrites `order` index across the entire car. We send all ids
      // grouped by SECTIONS to keep cross-section ordering predictable.
      const allOrdered = [
        ...SECTIONS.flatMap((s) =>
          s === activeSection
            ? sectionItems.map((x) => x.id)
            : others.filter((x) => x.section === s).sort((a, b) => a.order - b.order).map((x) => x.id),
        ),
      ];
      await api.reorderMedia(carId, allOrdered);
    } catch (e: any) { toast.show('Reorder failed', 'error'); load(); }
  };

  const onAttest = async () => {
    try {
      await api.attestNoDamage(carId, true);
      toast.show('No-visible-damage attested', 'success');
      load();
    } catch (e: any) { toast.show(e.message || 'Attestation failed', 'error'); }
  };

  // ---- Launch (draft → live) ----
  // Hard-gated server-side via /admin/auctions/{id}/launch-readiness.
  // We pre-flight to give the operator an explicit reason why launch is
  // blocked (e.g. "Mark one photo as Featured before launching.").
  //
  // CRITICAL: Alert.alert with custom buttons is a NO-OP on React Native
  // Web (it console.logs and returns). The earlier implementation
  // therefore appeared "broken" on the emergent.host preview — the
  // confirm dialog never appeared, so the launch call never fired.
  // We now branch on Platform.OS and use `window.confirm` on web.
  const performLaunch = async () => {
    if (!auctionId) {
      toast.show('Auction id missing — go back and try again', 'error');
      console.error('[media.launch] aborted — no auctionId in state');
      return;
    }
    console.log('[media.launch] POST /api/admin/auctions/' + auctionId + '/launch');
    setLaunching(true);
    try {
      const res: any = await api.launchAuction(auctionId);
      console.log('[media.launch] launched', { auctionId, status: res?.auction?.status, launched_at: res?.launched_at });
      toast.show('Auction is now LIVE', 'success');
      router.replace({ pathname: '/lot/[id]', params: { id: res.auction.id } } as any);
    } catch (e: any) {
      const detail = e?.message || '';
      console.error('[media.launch] FAILED', { auctionId, detail, status: e?.status });
      let msg = detail || 'Launch failed';
      if (detail.includes('LAUNCH_NOT_READY')) {
        msg = 'Launch blocked — readiness checks failed';
      } else if (/409|no longer in draft/i.test(detail)) {
        msg = 'This auction is already live (or was withdrawn)';
      } else if (/401|TOKEN_/i.test(detail)) {
        msg = 'Session expired — please sign in again';
      } else if (/403/i.test(detail)) {
        msg = 'Operator permission denied for this auction';
      } else if (/network/i.test(detail.toLowerCase())) {
        msg = 'Network error — check your connection and retry';
      }
      toast.show(msg, 'error');
      load();
    } finally {
      setLaunching(false);
    }
  };

  const onLaunch = async () => {
    console.log('[media.launch] tap', { auctionId, ready: readiness?.ready, status: auctionStatus, mediaCount: media.length, featured: media.filter((m) => m.is_featured).length });

    if (!auctionId) {
      toast.show('Auction id missing — reopen this listing from My Listings', 'error');
      console.error('[media.launch] no auctionId — discovery failed');
      return;
    }
    if (!readiness?.ready) {
      const reason = readiness?.issues?.[0] || 'Upload required media before launching';
      console.warn('[media.launch] not ready', { issues: readiness?.issues });
      // Just toast — Alert.alert(title, msg) without buttons works on
      // web, but the toast is more reliable + less noisy.
      toast.show(`Not ready: ${reason}`, 'error');
      return;
    }

    const confirmText = `${readiness.media_count} photos · ${readiness.featured_count} featured. Make this auction LIVE and visible to all dealers?`;

    // Cross-platform confirmation. On web we use the browser confirm
    // (which RN-Web's Alert does NOT polyfill for button arrays). On
    // native we use Alert.alert which DOES show buttons correctly.
    let confirmed = false;
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(confirmText)
        : true; // SSR or test env — just proceed
    } else {
      confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Launch this auction?',
          confirmText,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Launch now', style: 'destructive', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        );
      });
    }
    console.log('[media.launch] confirm result =', confirmed);
    if (!confirmed) return;

    await performLaunch();
  };

  // --- Derived state ---
  const sectionMedia = media.filter((m) => m.section === activeSection)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const sectionPending = pending.filter((p) => p.section === activeSection);

  const sectionCount = (s: SectionKey) =>
    media.filter((m) => m.section === s).length;
  const sectionMet = (s: SectionKey) =>
    sectionCount(s) >= (MANDATORY_MIN[s] || 0);

  if (loading) {
    return <View style={styles.loaderRoot}><ActivityIndicator color={colors.red} /></View>;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}><ArrowLeft size={20} color={colors.textPrimary} /></TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>INVENTORY MEDIA</Text>
          <Text style={styles.title}>Vehicle photos</Text>
        </View>
        <View style={styles.counter}>
          <Text style={styles.counterText}>{media.length}/{MAX_PER_CAR}</Text>
        </View>
      </View>

      {/* Draft / Launch banner — only shown when this auction is still draft */}
      {auctionStatus === 'draft' && readiness && (
        <View style={[styles.draftBar, readiness.ready ? styles.draftBarReady : styles.draftBarPending]}>
          <View style={{ flex: 1 }}>
            <View style={styles.draftBarTopRow}>
              <View style={[styles.draftPill, readiness.ready ? styles.draftPillReady : styles.draftPillPending]}>
                <Text style={[styles.draftPillText, readiness.ready ? { color: colors.success } : { color: colors.warning }]}>
                  {readiness.ready ? '✓ READY TO LAUNCH' : 'DRAFT — NOT VISIBLE TO DEALERS'}
                </Text>
              </View>
            </View>
            <Text style={styles.draftBarTitle}>
              {readiness.ready
                ? 'All checks passed. Launch when you are ready.'
                : `${readiness.media_count}/${readiness.min_photos_required} photos · ${readiness.featured_count} featured`}
            </Text>
            {!readiness.ready && readiness.issues.length > 0 && (
              <Text style={styles.draftBarIssue} numberOfLines={2}>
                • {readiness.issues[0]}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* Completeness banner */}
      {completeness && (
        <View style={[styles.banner, completeness.valid ? styles.bannerOk : styles.bannerWarn]}>
          {completeness.valid ? <ShieldCheck size={14} color={colors.success} /> : <ShieldAlert size={14} color={colors.warning} />}
          <Text style={[styles.bannerText, { color: completeness.valid ? colors.success : colors.warning }]}>
            {completeness.valid
              ? 'All mandatory sections complete · ready to launch'
              : `${(completeness.missing || []).length} section${(completeness.missing || []).length !== 1 ? 's' : ''} below minimum`}
          </Text>
        </View>
      )}

      {/* Section tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
        {SECTIONS.map((s) => {
          const count = sectionCount(s);
          const min = MANDATORY_MIN[s] || 0;
          const met = sectionMet(s);
          const isDamage = s === 'damage';
          const isActive = activeSection === s;
          return (
            <TouchableOpacity
              key={s}
              onPress={() => setActiveSection(s)}
              style={[styles.tab, isActive && styles.tabActive]}
              testID={`media-tab-${s}`}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>{SECTION_LABELS[s]}</Text>
              <View style={[
                styles.tabCount,
                met ? styles.tabCountOk : styles.tabCountWarn,
                isDamage && (completeness?.no_damage_attested || count >= 1) && styles.tabCountOk,
              ]}>
                <Text style={styles.tabCountText}>
                  {isDamage
                    ? (completeness?.no_damage_attested ? '✓' : `${count}`)
                    : `${count}/${min}`}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Section hint */}
      <Text style={styles.hint}>{SECTION_HINTS[activeSection]}</Text>

      {/* Damage attestation */}
      {activeSection === 'damage' && !completeness?.no_damage_attested && sectionMedia.length === 0 && (
        <View style={styles.damageAttestBox}>
          <Text style={styles.damageAttestTitle}>No visible major damage?</Text>
          <Text style={styles.damageAttestSub}>If the car has no visible damage, attest it explicitly. Otherwise upload damage photos.</Text>
          <TouchableOpacity onPress={onAttest} style={styles.damageAttestBtn}>
            <CheckCircle2 size={14} color={colors.success} />
            <Text style={styles.damageAttestBtnText}>Attest "No visible major damage"</Text>
          </TouchableOpacity>
        </View>
      )}
      {activeSection === 'damage' && completeness?.no_damage_attested && (
        <View style={[styles.damageAttestBox, { borderColor: 'rgba(16,185,129,0.4)' }]}>
          <Text style={[styles.damageAttestTitle, { color: colors.success }]}>"No visible major damage" attested</Text>
          <Text style={styles.damageAttestSub}>Upload photos here if damage is later identified.</Text>
        </View>
      )}

      {/* Drag-drop grid (single column with thumbnails) */}
      <DraggableFlatList
        data={sectionMedia}
        keyExtractor={(item) => item.id}
        onDragEnd={({ data }) => onReorder(data)}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }}
        ListHeaderComponent={
          <TouchableOpacity onPress={pickAndUpload} style={styles.uploadCta} testID="media-upload-btn">
            <ImagePlus size={20} color={colors.red} />
            <Text style={styles.uploadCtaText}>Upload photos to {SECTION_LABELS[activeSection]}</Text>
            <Text style={styles.uploadCtaSub}>Up to 20 at once · auto-compressed · auto-retry on failure</Text>
          </TouchableOpacity>
        }
        ListFooterComponent={
          sectionPending.length > 0 ? (
            <View style={styles.pendingBlock}>
              {sectionPending.map((p) => (
                <View key={p.localId} style={styles.pendingItem}>
                  <Image source={{ uri: p.uri }} style={styles.pendingThumb} contentFit="cover" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pendingLabel}>
                      {p.status === 'compressing' ? 'Compressing…' :
                       p.status === 'uploading' ? `Uploading ${Math.round(p.pct * 100)}%` :
                       p.status === 'done' ? 'Done' :
                       p.status === 'error' ? 'Failed' : 'Queued'}
                    </Text>
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${Math.max(p.status === 'done' ? 100 : p.status === 'error' ? 0 : p.pct * 100, 6)}%` }, p.status === 'error' && { backgroundColor: colors.red }]} />
                    </View>
                  </View>
                  {p.status === 'error' && (
                    <TouchableOpacity onPress={() => retryFailed(p.localId)} style={styles.retryBtn}>
                      <Text style={styles.retryBtnText}>Retry</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </View>
          ) : null
        }
        renderItem={({ item, drag, isActive }: RenderItemParams<Media>) => (
          <ScaleDecorator>
            <View style={[styles.row, isActive && styles.rowActive]}>
              <TouchableOpacity onLongPress={drag} delayLongPress={150} onPress={() => setPreviewIndex(sectionMedia.findIndex((x) => x.id === item.id))}>
                <Image source={{ uri: absUrl(item.thumb_url || item.url) }} style={styles.rowThumb} contentFit="cover" transition={150} />
                {item.is_featured && (
                  <View style={styles.featuredBadge}>
                    <Star size={10} color={colors.warning} fill={colors.warning} />
                  </View>
                )}
              </TouchableOpacity>
              <View style={{ flex: 1, paddingLeft: 12 }}>
                <Text style={styles.rowMeta}>#{(item.order ?? 0) + 1}{item.is_featured ? ' · FEATURED' : ''}</Text>
                {!!item.original_name && <Text style={styles.rowName} numberOfLines={1}>{item.original_name}</Text>}
                <View style={styles.rowActions}>
                  {!item.is_featured && (
                    <TouchableOpacity onPress={() => onSetFeatured(item)} style={styles.actionBtn}>
                      <Star size={12} color={colors.textChrome} />
                      <Text style={styles.actionText}>Set featured</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => setMoveTarget(item)} style={styles.actionBtn}>
                    <Move size={12} color={colors.textChrome} />
                    <Text style={styles.actionText}>Move</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => onDelete(item)} style={styles.actionBtn}>
                    <Trash2 size={12} color={colors.red} />
                    <Text style={[styles.actionText, { color: colors.red }]}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <TouchableOpacity onLongPress={drag} delayLongPress={120} style={styles.dragHandle}>
                <Move size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </ScaleDecorator>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No photos in {SECTION_LABELS[activeSection]} yet</Text>
            <Text style={styles.emptySub}>Min {MANDATORY_MIN[activeSection] || 0} required for launch</Text>
          </View>
        }
      />

      {/* Sticky Launch CTA — only when auction is still a draft */}
      {auctionStatus === 'draft' && (
        <View style={[styles.launchFabWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <TouchableOpacity
            onPress={onLaunch}
            // Only block taps WHILE a launch request is in flight — when
            // not-ready we let the tap through so `onLaunch` can fire a
            // toast naming the exact blocker (rather than a "dead
            // button" that operators interpret as a bug).
            disabled={launching}
            activeOpacity={0.85}
            style={[styles.launchFab, !readiness?.ready && styles.launchFabDisabled]}
            testID="media-launch-btn"
          >
            {launching ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Rocket size={18} color="#fff" />
            )}
            <Text style={styles.launchFabText}>
              {launching
                ? 'Launching...'
                : readiness?.ready
                  ? 'Launch Auction'
                  : !readiness
                    ? 'Checking readiness…'
                    : `Upload ${Math.max(0, (readiness.min_photos_required || 3) - (readiness.media_count || 0))} more${readiness.featured_count ? '' : ' · pick featured'}`}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Move-to-section sheet */}
      <Modal visible={!!moveTarget} transparent animationType="fade" onRequestClose={() => setMoveTarget(null)}>
        <Pressable style={styles.backdrop} onPress={() => setMoveTarget(null)}>
          <Pressable style={styles.sheet}>
            <Text style={styles.sheetTitle}>Move to section</Text>
            {SECTIONS.map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => moveTarget && onChangeSection(moveTarget, s)}
                style={[styles.sheetRow, moveTarget?.section === s && styles.sheetRowActive]}
              >
                <Text style={styles.sheetText}>{SECTION_LABELS[s]}</Text>
                {moveTarget?.section === s && <CheckCircle2 size={14} color={colors.red} />}
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Lightweight preview modal (full image, swipe between within section) */}
      <Modal visible={previewIndex !== null} transparent animationType="fade" onRequestClose={() => setPreviewIndex(null)}>
        <View style={styles.previewRoot}>
          <TouchableOpacity onPress={() => setPreviewIndex(null)} style={styles.previewClose}><X size={22} color="#fff" /></TouchableOpacity>
          {previewIndex !== null && sectionMedia[previewIndex] && (
            <Image
              source={{ uri: absUrl(sectionMedia[previewIndex].url) }}
              style={styles.previewImage}
              contentFit="contain"
              transition={200}
            />
          )}
          <Text style={styles.previewIndex}>{(previewIndex ?? 0) + 1} / {sectionMedia.length}</Text>
        </View>
      </Modal>
    </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  loaderRoot: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 12, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  kicker: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '800', marginTop: 2, letterSpacing: -0.3 },
  counter: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  counterText: { color: colors.textChrome, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },

  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 20, marginTop: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radii.md, borderWidth: 1 },
  bannerOk: { backgroundColor: 'rgba(16,185,129,0.06)', borderColor: 'rgba(16,185,129,0.4)' },
  bannerWarn: { backgroundColor: 'rgba(245,158,11,0.06)', borderColor: 'rgba(245,158,11,0.4)' },
  bannerText: { fontSize: 12, fontWeight: '700' },

  tabsRow: { gap: 8, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 },
  tabActive: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: colors.red },
  tabText: { color: colors.textChrome, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  tabTextActive: { color: colors.red },
  tabCount: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  tabCountOk: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)' },
  tabCountWarn: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.4)' },
  tabCountText: { color: '#fff', fontSize: 10, fontWeight: '900' },

  hint: { color: colors.textMuted, fontSize: 11, paddingHorizontal: 20, marginTop: 6, marginBottom: 10, fontStyle: 'italic' },

  damageAttestBox: { marginHorizontal: 20, marginBottom: 12, padding: 14, borderRadius: radii.md, borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)', backgroundColor: 'rgba(245,158,11,0.05)' },
  damageAttestTitle: { color: colors.warning, fontSize: 13, fontWeight: '800', letterSpacing: 0.2 },
  damageAttestSub: { color: colors.textChrome, fontSize: 11, marginTop: 4, lineHeight: 16 },
  damageAttestBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)', borderWidth: 1, borderRadius: 999 },
  damageAttestBtnText: { color: colors.success, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },

  uploadCta: { marginTop: 4, marginBottom: 16, padding: 18, borderRadius: radii.md, borderWidth: 1, borderColor: colors.red, backgroundColor: 'rgba(185,28,28,0.06)', alignItems: 'center', gap: 6 },
  uploadCtaText: { color: colors.red, fontSize: 14, fontWeight: '800', letterSpacing: 0.2 },
  uploadCtaSub: { color: colors.textMuted, fontSize: 11 },

  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 10, marginBottom: 10 },
  rowActive: { borderColor: colors.red, shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 6 },
  rowThumb: { width: 92, height: 70, borderRadius: 8, backgroundColor: '#000' },
  featuredBadge: { position: 'absolute', top: 4, left: 4, backgroundColor: 'rgba(0,0,0,0.7)', paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 },
  rowMeta: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  rowName: { color: colors.textChrome, fontSize: 11, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  actionText: { color: colors.textChrome, fontSize: 10, fontWeight: '700' },
  dragHandle: { padding: 8 },

  pendingBlock: { marginTop: 12 },
  pendingItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, marginBottom: 8, borderRadius: radii.md, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 },
  pendingThumb: { width: 50, height: 50, borderRadius: 6, backgroundColor: '#000' },
  pendingLabel: { color: colors.textPrimary, fontSize: 11, fontWeight: '700' },
  progressTrack: { height: 4, marginTop: 5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.07)', overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: colors.red },
  retryBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.10)', borderColor: colors.red, borderWidth: 1 },
  retryBtnText: { color: colors.red, fontSize: 10, fontWeight: '800' },

  empty: { alignItems: 'center', paddingVertical: 30 },
  emptyText: { color: colors.textChrome, fontSize: 13, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 11, marginTop: 4 },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bgElevated, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 32, borderTopWidth: 1, borderColor: colors.border },
  sheetTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', marginBottom: 12 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, paddingHorizontal: 12, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  sheetRowActive: { backgroundColor: 'rgba(185,28,28,0.06)' },
  sheetText: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },

  previewRoot: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  previewClose: { position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, right: 16, zIndex: 5, width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '85%' },
  previewIndex: { position: 'absolute', bottom: Platform.OS === 'ios' ? 50 : 30, color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 1.4, opacity: 0.8 },

  // Draft / Launch banner & sticky FAB
  draftBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 20, marginTop: 12, paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: radii.md, borderWidth: 1,
  },
  draftBarPending: { backgroundColor: 'rgba(245,158,11,0.06)', borderColor: 'rgba(245,158,11,0.4)' },
  draftBarReady:   { backgroundColor: 'rgba(16,185,129,0.06)', borderColor: 'rgba(16,185,129,0.45)' },
  draftBarTopRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  draftPill:       { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1 },
  draftPillPending:{ backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.5)' },
  draftPillReady:  { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.5)' },
  draftPillText:   { fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2 },
  draftBarTitle:   { color: colors.textPrimary, fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
  draftBarIssue:   { color: colors.textChrome, fontSize: 11, fontWeight: '600', marginTop: 3, lineHeight: 15 },

  launchFabWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 10,
    backgroundColor: 'rgba(11,11,13,0.96)',
    borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth,
  },
  launchFab: {
    backgroundColor: colors.red,
    paddingVertical: 16, borderRadius: radii.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.45, shadowRadius: 16, elevation: 8,
  },
  launchFabDisabled: { backgroundColor: '#3F2828', shadowOpacity: 0 },
  launchFabText: { color: '#fff', fontSize: 15, fontWeight: '900', letterSpacing: 0.4 },
});
