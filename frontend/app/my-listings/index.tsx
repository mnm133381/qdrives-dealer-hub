/**
 * Vehicle edit / "My Listings" screen.
 * Sellers manage their listed cars here — including replacing the
 * inspection PDF for any of their auctions.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, ActivityIndicator, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { ArrowLeft, FileText, Upload, ChevronRight, ShieldCheck, FileX, Eye } from 'lucide-react-native';
import { colors, formatINR, radii } from '../../src/theme';
import { api, inspectionPdfUrl } from '../../src/api';
import { useAuth } from '../../src/auth';
import { useToast } from '../../src/toast';
import { Linking, Platform } from 'react-native';

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

  const load = useCallback(async () => {
    try {
      const all: any[] = await api.auctions();
      setAuctions(all.filter((a) => a.seller_id === dealer?.id));
    } catch {} finally {
      setLoading(false);
    }
  }, [dealer?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

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

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}
      >
        {loading ? (
          <View style={styles.empty}><ActivityIndicator color={colors.red} /></View>
        ) : auctions.length === 0 ? (
          <View style={styles.empty}>
            <FileText size={28} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No listings yet</Text>
            <Text style={styles.emptySub}>Use the Sell tab to launch your first auction.</Text>
          </View>
        ) : (
          auctions.map((a) => {
            const car = a.car || {};
            const insp = a.inspection_pdf;
            const isUploading = uploadingFor === a.id;
            return (
              <View key={a.id} style={styles.card} testID={`my-listing-${a.id}`}>
                <TouchableOpacity onPress={() => router.push(`/auction/${a.id}`)} style={styles.cardHead} activeOpacity={0.85}>
                  <Image source={{ uri: car.images?.[0] }} style={styles.thumb} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{car.year} {car.make} {car.model}</Text>
                    <Text style={styles.cardSub} numberOfLines={1}>{car.registration_number} · {(car.km_driven || 0).toLocaleString('en-IN')} km</Text>
                    <Text style={styles.cardPrice}>{formatINR(a.current_bid || a.starting_bid)}</Text>
                  </View>
                  <ChevronRight size={16} color={colors.textMuted} />
                </TouchableOpacity>

                <View style={styles.divider} />

                <TouchableOpacity
                  onPress={() => router.push(`/inventory/${car.id}/media`)}
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
                        {insp ? `${insp.filename || 'inspection.pdf'} · ${(insp.version || 'v1').toUpperCase()}` : 'Attach a detailed report to boost trust'}
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  kicker: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: '800', marginTop: 2, letterSpacing: -0.4 },

  empty: { alignItems: 'center', paddingVertical: 80, gap: 12 },
  emptyTitle: { color: colors.textChrome, fontSize: 16, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 12, textAlign: 'center', maxWidth: 260 },

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
