/**
 * Vehicle edit / "My Listings" screen.
 * Sellers manage their listed cars here — including replacing the
 * inspection PDF for any of their auctions.
 */
import React, { useCallback, useState, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { firstCarImage } from '../../src/imageUri';
import { ArrowLeft, FileText, Upload, ChevronRight, ShieldCheck, FileX, Eye, Pause, Play, XCircle, Archive, Lock, Edit3, ClipboardEdit } from 'lucide-react-native';
import { colors, formatINR, maskRegNo, radii } from '../../src/theme';
import { api, inspectionPdfUrl } from '../../src/api';
import { useAuth } from '../../src/auth';
import { useToast } from '../../src/toast';
import { Linking, Platform, Alert } from 'react-native';
import { ReasonModal } from '../../src/components/ReasonModal';
import { statusBadge } from '../../src/lifecycle';

type AuctionRow = any;

export default function MyListings() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dealer } = useAuth();
  const toast = useToast();

  // Admin-only — dealers can't manage Q Drives inventory.
  if (dealer && !['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(dealer.role as any)) {
    return <Redirect href="/(tabs)/" />;
  }

  const [auctions, setAuctions] = useState<AuctionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  type Tab = 'active' | 'paused' | 'sold' | 'withdrawn' | 'drafts';
  const [tab, setTab] = useState<Tab>('active');
  const [reasonModal, setReasonModal] = useState<{ kind: 'withdraw' | 'archive'; auction: any } | null>(null);

  const load = useCallback(async () => {
    try {
      // Use the operator-scoped variant which INCLUDES drafts. Without
      // `seller_id=me` the marketplace filter strips drafts and the
      // "Drafts" tab is permanently empty, even right after the
      // operator taps "Save draft & upload photos" on the Sell screen.
      const all: any[] = await api.auctions(undefined, 'me');
      setAuctions(all.filter((a) => a.seller_id === dealer?.id));
    } catch {} finally {
      setLoading(false);
    }
  }, [dealer?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Filter by tab
  const filtered = useMemo(() => auctions.filter((a) => {
    const s = (a.status || 'live') as string;
    if (tab === 'paused')    return s === 'paused';
    if (tab === 'withdrawn') return s === 'withdrawn' || s === 'archived';
    if (tab === 'sold')      return ['settled', 'payment_received', 'vehicle_released', 'ended_pending_payment', 'dispute', 'cancelled'].includes(s);
    if (tab === 'drafts')    return s === 'draft' || s === 'scheduled';
    return s === 'live'; // active
  }), [auctions, tab]);

  const counts = useMemo(() => ({
    active:   auctions.filter((a) => (a.status || 'live') === 'live').length,
    paused:   auctions.filter((a) => a.status === 'paused').length,
    sold:     auctions.filter((a) => ['settled','payment_received','vehicle_released','ended_pending_payment','dispute','cancelled'].includes(a.status)).length,
    withdrawn:auctions.filter((a) => a.status === 'withdrawn' || a.status === 'archived').length,
    drafts:   auctions.filter((a) => a.status === 'draft' || a.status === 'scheduled').length,
  }), [auctions]);

  // ---- Lifecycle actions ----
  const onPause = async (a: any) => {
    try { await api.adminPauseAuction(a.id, 'Seller paused listing'); toast.show('Listing paused', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };
  const onResume = async (a: any) => {
    try { await api.adminResumeAuction(a.id); toast.show('Listing resumed', 'success'); load(); }
    catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };
  const onWithdrawSubmit = async (reason: string) => {
    if (!reasonModal) return;
    try {
      await api.inventoryWithdraw(reasonModal.auction.id, reason);
      toast.show('Listing withdrawn', 'success');
      setReasonModal(null); load();
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };
  const onArchiveSubmit = async (note: string) => {
    if (!reasonModal) return;
    try {
      await api.inventoryArchive(reasonModal.auction.id, note);
      toast.show('Listing archived', 'success');
      setReasonModal(null); load();
    } catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
  };
  const onEditReserve = async (a: any) => {
    Alert.prompt?.('Edit reserve price', `Current: ${formatINR(a.reserve_price || 0)}\nReserve can only be edited before the first bid.`, async (txt) => {
      const n = parseInt((txt || '').replace(/[^0-9]/g, ''), 10);
      if (!n || n <= 0) return;
      try { await api.inventorySetReserve(a.id, n); toast.show('Reserve updated', 'success'); load(); }
      catch (e: any) { toast.show(e.message || 'Failed', 'error'); }
    }, 'plain-text');
  };

  const replacePdf = async (a: AuctionRow) => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
      if (res.canceled) return;
      const f = res.assets?.[0];
      if (!f) return;
      if (f.size && f.size > 10 * 1024 * 1024) { toast.show('PDF must be under 10 MB', 'error'); return; }
      setUploadingFor(a.id);
      await api.uploadInspection(a.car_id, f.uri, f.name || 'inspection.pdf');
      toast.show('Inspection PDF updated', 'success');
      await load();
    } catch (e: any) {
      toast.show(e.message || 'Upload failed', 'error');
    } finally {
      setUploadingFor(null);
    }
  };

  const viewPdf = async (insp: any) => {
    if (!insp) return;
    try {
      const url = await inspectionPdfUrl(insp.id);
      if (await Linking.canOpenURL(url).catch(() => true) || Platform.OS === 'web') {
        await Linking.openURL(url);
      }
    } catch (e: any) {
      toast.show(e.message || 'Failed to open PDF', 'error');
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="my-listings-back">
          <ArrowLeft size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={styles.kicker}>VEHICLE EDIT</Text>
          <Text style={styles.title}>My listings</Text>
        </View>
      </View>

      {/* Lifecycle segmented tabs */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
        {([
          { k: 'active',    label: 'ACTIVE',    n: counts.active,    tint: colors.success },
          { k: 'paused',    label: 'PAUSED',    n: counts.paused,    tint: colors.warning },
          { k: 'sold',      label: 'SOLD',      n: counts.sold,      tint: colors.silver },
          { k: 'withdrawn', label: 'WITHDRAWN', n: counts.withdrawn, tint: colors.warning },
          { k: 'drafts',    label: 'DRAFTS',    n: counts.drafts,    tint: colors.textMuted },
        ] as const).map((t) => (
          <TouchableOpacity
            key={t.k}
            onPress={() => setTab(t.k as Tab)}
            style={[styles.tab, tab === t.k && { borderColor: t.tint, backgroundColor: t.tint + '14' }]}
            testID={`my-listings-tab-${t.k}`}
          >
            <Text style={[styles.tabText, tab === t.k && { color: t.tint }]}>{t.label}</Text>
            <View style={[styles.tabCount, tab === t.k && { backgroundColor: t.tint }]}>
              <Text style={[styles.tabCountText, tab === t.k && { color: '#fff' }]}>{t.n}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingTop: 10, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {loading ? (
          <View style={styles.empty}><ActivityIndicator color={colors.red} /></View>
        ) : filtered.length === 0 ? (
          <View style={styles.empty}>
            <FileText size={28} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No {tab} listings</Text>
            <Text style={styles.emptySub}>Switch tab or list a new vehicle to start an auction.</Text>
            <TouchableOpacity
              onPress={() => router.push('/(admin)/launch' as any)}
              style={styles.emptyCta}
              testID="my-listings-empty-list-car"
              activeOpacity={0.85}
            >
              <Upload size={14} color="#fff" strokeWidth={2.5} />
              <Text style={styles.emptyCtaText}>+ LIST CAR</Text>
            </TouchableOpacity>
          </View>
        ) : (
          filtered.map((a) => {
            const car = a.car || {};
            const insp = a.inspection_pdf;
            const isUploading = uploadingFor === a.id;
            const badge = statusBadge(a.status);
            const isLive = a.status === 'live';
            const isPaused = a.status === 'paused';
            const isWithdrawn = a.status === 'withdrawn';
            const isTerminal = ['settled', 'cancelled', 'archived', 'withdrawn'].includes(a.status || '');
            const hasBids = (a.total_bids || 0) > 0;
            const lockedByOperator = !!a.operator_lock;
            return (
              <View key={a.id} style={styles.card} testID={`my-listing-${a.id}`}>
                <TouchableOpacity onPress={() => router.push({ pathname: '/lot/[id]', params: { id: a.id } } as any)} style={styles.cardHead} activeOpacity={0.85}>
                  <Image source={{ uri: firstCarImage(car.images) }} style={styles.thumb} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <View style={styles.titleRow}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{car.year} {car.make} {car.model}</Text>
                      <View style={[styles.statusPill, { borderColor: badge.tint + '55', backgroundColor: badge.tint + '15' }]}>
                        <Text style={[styles.statusPillText, { color: badge.tint }]}>{badge.label}</Text>
                      </View>
                    </View>
                    <Text style={styles.cardSub} numberOfLines={1}>{maskRegNo(car.registration_number)} · {(car.km_driven || 0).toLocaleString('en-IN')} km</Text>
                    <Text style={styles.cardPrice}>{formatINR(a.current_bid || a.starting_bid)}</Text>
                    {lockedByOperator && (
                      <View style={styles.lockedRow}>
                        <Lock size={10} color={colors.red} />
                        <Text style={styles.lockedText}>OPERATOR LOCKED</Text>
                      </View>
                    )}
                  </View>
                  <ChevronRight size={16} color={colors.textMuted} />
                </TouchableOpacity>

                {/* Lifecycle controls */}
                {!isTerminal && !lockedByOperator && (
                  <>
                    <View style={styles.divider} />
                    <View style={styles.lifecycleRow}>
                      {isLive && (
                        <TouchableOpacity onPress={() => onPause(a)} style={[styles.lcBtn, styles.lcBtnWarn]} testID={`my-listing-${a.id}-pause`}>
                          <Pause size={12} color={colors.warning} />
                          <Text style={[styles.lcBtnText, { color: colors.warning }]}>Pause</Text>
                        </TouchableOpacity>
                      )}
                      {isPaused && (
                        <TouchableOpacity onPress={() => onResume(a)} style={[styles.lcBtn, styles.lcBtnGood]} testID={`my-listing-${a.id}-resume`}>
                          <Play size={12} color={colors.success} />
                          <Text style={[styles.lcBtnText, { color: colors.success }]}>Resume</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => setReasonModal({ kind: 'withdraw', auction: a })} style={[styles.lcBtn, styles.lcBtnDanger]} testID={`my-listing-${a.id}-withdraw`}>
                        <XCircle size={12} color={colors.red} />
                        <Text style={[styles.lcBtnText, { color: colors.red }]}>Withdraw</Text>
                      </TouchableOpacity>
                      {!hasBids && a.reserve_price !== undefined && (
                        <TouchableOpacity onPress={() => onEditReserve(a)} style={[styles.lcBtn, styles.lcBtnSilver]} testID={`my-listing-${a.id}-reserve`}>
                          <Edit3 size={12} color={colors.silver} />
                          <Text style={[styles.lcBtnText, { color: colors.silver }]}>Reserve</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </>
                )}
                {(['settled', 'cancelled', 'withdrawn', 'ended'] as string[]).includes(a.status || '') && (
                  <>
                    <View style={styles.divider} />
                    <View style={styles.lifecycleRow}>
                      <TouchableOpacity onPress={() => setReasonModal({ kind: 'archive', auction: a })} style={[styles.lcBtn, styles.lcBtnSilver]} testID={`my-listing-${a.id}-archive`}>
                        <Archive size={12} color={colors.silver} />
                        <Text style={[styles.lcBtnText, { color: colors.silver }]}>Archive</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}

                <View style={styles.divider} />

                <TouchableOpacity
                  onPress={() => router.push({
                    pathname: '/inventory/[carId]/media',
                    params: { carId: car.id, auctionId: a.id },
                  } as any)}
                  style={styles.mediaRow}
                  activeOpacity={0.85}
                  testID={`my-listing-${a.id}-media`}
                >
                  <View style={styles.mediaIcon}>
                    <FileText size={14} color={colors.red} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.mediaLabel}>VEHICLE PHOTOS</Text>
                    <Text style={styles.mediaSub}>Manage gallery, sections, featured & ordering</Text>
                  </View>
                  <ChevronRight size={14} color={colors.textMuted} />
                </TouchableOpacity>

                <View style={styles.divider} />

                {/* ── Edit inspection (post-launch) ─────────────────
                    Routes to the canonical inspection editor. The
                    edit screen GETs the full record on mount, PUTs
                    on save, and the backend broadcasts a WS frame
                    to every open lot screen so bidders see the
                    updated grade in real time. */}
                <TouchableOpacity
                  onPress={() => router.push({
                    pathname: '/inventory/[carId]/inspection',
                    params: { carId: car.id, auctionId: a.id },
                  } as any)}
                  style={styles.mediaRow}
                  activeOpacity={0.85}
                  testID={`my-listing-${a.id}-edit-inspection`}
                >
                  <View style={[styles.mediaIcon, { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.35)' }]}>
                    <ClipboardEdit size={14} color={colors.success} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.mediaLabel}>EDIT INSPECTION</Text>
                    <Text style={styles.mediaSub}>Re-grade, update accident / tyre / service notes</Text>
                  </View>
                  <ChevronRight size={14} color={colors.textMuted} />
                </TouchableOpacity>

                <View style={styles.divider} />

                <View style={styles.pdfBlock}>
                  <View style={styles.pdfLeft}>
                    <View style={[styles.pdfIcon, insp ? { backgroundColor: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.4)' } : { backgroundColor: colors.bg, borderColor: colors.border }]}>
                      {insp ? <ShieldCheck size={16} color={colors.success} /> : <FileX size={16} color={colors.textMuted} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.pdfStatus, { color: insp ? colors.success : colors.textMuted }]}>
                        {insp ? 'PDF ATTACHED' : 'NO PDF'}
                      </Text>
                      <Text style={styles.pdfMeta} numberOfLines={1}>
                        {insp
                          ? `${insp.filename || 'inspection.pdf'} · ${
                              // `version` was historically a string ("v1"/"v2"),
                              // but the canonical inspection now uses a numeric
                              // auto-incrementing version field. Coerce both
                              // shapes back to a display string so the row
                              // never crashes on .toUpperCase() against a number.
                              typeof insp.version === 'number'
                                ? `V${insp.version}`
                                : (String(insp.version || 'v1').toUpperCase())
                            }`
                          : 'Attach a detailed report to boost trust'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.pdfActions}>
                    {insp && (
                      <TouchableOpacity onPress={() => viewPdf(insp)} style={styles.pdfBtnSecondary} testID={`my-listing-${a.id}-view`}>
                        <Eye size={13} color={colors.textChrome} />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      onPress={() => replacePdf(a)}
                      disabled={isUploading}
                      style={[styles.pdfBtnPrimary, !insp && styles.pdfBtnPrimaryAttach]}
                      testID={`my-listing-${a.id}-upload`}
                    >
                      {isUploading ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <>
                          <Upload size={13} color="#fff" />
                          <Text style={styles.pdfBtnText}>{insp ? 'Replace' : 'Attach PDF'}</Text>
                        </>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Reason modal for withdraw / archive — both audited */}
      {reasonModal && (
        <ReasonModal
          visible
          title={reasonModal.kind === 'withdraw' ? 'Withdraw listing' : 'Archive listing'}
          kicker={reasonModal.kind === 'withdraw' ? 'AUDITED · WITHDRAW' : 'AUDITED · ARCHIVE'}
          cta={reasonModal.kind === 'withdraw' ? 'Withdraw listing' : 'Archive vehicle'}
          danger={reasonModal.kind === 'withdraw'}
          onClose={() => setReasonModal(null)}
          onSubmit={(text) => reasonModal.kind === 'withdraw' ? onWithdrawSubmit(text) : onArchiveSubmit(text)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  kicker: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', marginTop: 2, letterSpacing: -0.4 },

  tabsRow: { paddingHorizontal: 20, gap: 8, paddingTop: 4, paddingBottom: 8 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  tabText: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  tabCount: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: colors.border },
  tabCountText: { color: colors.textPrimary, fontSize: 10, fontWeight: '900', fontVariant: ['tabular-nums'] },

  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, borderWidth: 1, marginLeft: 'auto' },
  statusPillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  lockedRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  lockedText: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },

  lifecycleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 12 },
  lcBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999, borderWidth: 1, backgroundColor: colors.bgCard },
  lcBtnText: { fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },
  lcBtnWarn:   { borderColor: 'rgba(245,158,11,0.45)', backgroundColor: 'rgba(245,158,11,0.08)' },
  lcBtnDanger: { borderColor: 'rgba(185,28,28,0.45)',  backgroundColor: 'rgba(185,28,28,0.06)'  },
  lcBtnGood:   { borderColor: 'rgba(16,185,129,0.45)', backgroundColor: 'rgba(16,185,129,0.08)' },
  lcBtnSilver: { borderColor: 'rgba(160,160,170,0.45)', backgroundColor: 'rgba(160,160,170,0.06)' },

  empty: { alignItems: 'center', paddingVertical: 80, gap: 12 },
  emptyTitle: { color: colors.textChrome, fontSize: 16, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 12, textAlign: 'center', maxWidth: 260 },
  emptyCta: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 999, backgroundColor: colors.red, marginTop: 8 },
  emptyCtaText: { color: '#fff', fontSize: 12.5, fontWeight: '900', letterSpacing: 1 },

  card: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, marginBottom: 14, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  thumb: { width: 64, height: 64, borderRadius: 10, backgroundColor: '#000' },
  cardTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  cardSub: { color: colors.textSecondary, fontSize: 11, marginTop: 3, fontWeight: '600' },
  cardPrice: { color: colors.red, fontSize: 14, fontWeight: '800', marginTop: 5, letterSpacing: -0.3 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },

  pdfBlock: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  pdfLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  pdfIcon: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  pdfStatus: { fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  pdfMeta: { color: colors.textChrome, fontSize: 11, fontWeight: '600', marginTop: 2 },

  pdfActions: { flexDirection: 'row', gap: 6 },
  pdfBtnSecondary: { width: 34, height: 34, borderRadius: 8, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  pdfBtnPrimary: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 8, backgroundColor: colors.red },
  pdfBtnPrimaryAttach: { backgroundColor: colors.red },
  pdfBtnText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },

  mediaRow: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  mediaIcon: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)', backgroundColor: 'rgba(185,28,28,0.08)', alignItems: 'center', justifyContent: 'center' },
  mediaLabel: { color: colors.red, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  mediaSub: { color: colors.textChrome, fontSize: 11, fontWeight: '600', marginTop: 2 },
});
