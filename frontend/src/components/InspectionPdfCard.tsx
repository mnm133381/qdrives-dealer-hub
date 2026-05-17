/**
 * View-only inspection PDF card for the auction/marketplace screen.
 * No upload/replace UI here — that's strictly handled in the seller
 * listing flow and the vehicle-edit ("My Listings") workflow.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking, Platform } from 'react-native';
import { FileText, Download, Eye, FileX, Clock, ShieldCheck, BadgeCheck, Calendar, User } from 'lucide-react-native';
import { colors, radii } from '../theme';
import { inspectionPdfUrl } from '../api';
import { useToast } from '../toast';

type Props = {
  inspection: any | null;
};

function formatBytes(b: number) {
  if (!b) return '0 KB';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelative(iso?: string) {
  if (!iso) return '';
  try {
    const d = new Date(iso).getTime();
    const diff = Math.max(0, Date.now() - d);
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} hr ago`;
    return `${Math.floor(diff / 86400_000)} d ago`;
  } catch { return ''; }
}

function formatAbsolute(iso?: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

export function InspectionPdfCard({ inspection }: Props) {
  const toast = useToast();
  const [opening, setOpening] = useState<'view' | 'download' | null>(null);

  const open = async (mode: 'view' | 'download') => {
    if (!inspection) return;
    setOpening(mode);
    try {
      const url = await inspectionPdfUrl(inspection.id);
      const supported = await Linking.canOpenURL(url).catch(() => true);
      if (supported || Platform.OS === 'web') {
        await Linking.openURL(url);
      } else {
        toast.show('No PDF viewer available on this device', 'error');
      }
    } catch (e: any) {
      toast.show(e.message || 'Failed to open PDF', 'error');
    } finally {
      setOpening(null);
    }
  };

  // Empty state
  if (!inspection) {
    return (
      <View style={[styles.card, styles.cardEmpty]} testID="insp-pdf-empty">
        <View style={styles.headRow}>
          <View style={[styles.iconBox, { backgroundColor: colors.bg, borderColor: colors.border }]}>
            <FileX size={18} color={colors.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: colors.textMuted }]} />
              <Text style={[styles.statusLabel, { color: colors.textMuted }]}>NOT ATTACHED</Text>
            </View>
            <Text style={styles.title}>Detailed report unavailable</Text>
            <Text style={styles.sub}>The seller has not uploaded a downloadable inspection PDF for this listing yet.</Text>
          </View>
        </View>
      </View>
    );
  }

  // Verified / available state
  return (
    <View style={[styles.card, styles.cardVerified]} testID="insp-pdf-card">
      <View style={styles.headRow}>
        <View style={[styles.iconBox, { backgroundColor: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.4)' }]}>
          <FileText size={18} color={colors.success} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.statusRow}>
            <BadgeCheck size={12} color={colors.success} />
            <Text style={[styles.statusLabel, { color: colors.success }]}>VERIFIED INSPECTION</Text>
          </View>
          <Text style={styles.title} numberOfLines={1}>{inspection.filename || 'inspection.pdf'}</Text>
          <Text style={styles.sizeMeta}>
            {/* Version is now an int on the new canonical record but
                was a string ("v1"/"v2") on legacy PDF uploads. Coerce
                safely so neither shape crashes the renderer. */}
            {formatBytes(inspection.size_bytes || 0)} · {
              typeof inspection.version === 'number'
                ? `V${inspection.version}`
                : String(inspection.version || 'v1').toUpperCase()
            }
          </Text>
        </View>
      </View>

      {/* Metadata strip — uploaded date now reads from BOTH the new
          canonical sub-doc (`uploaded_at`) AND the legacy flat record
          (`created_at`), so post-migration listings render correctly.
          Falls back gracefully to the inspection record's updated_at
          if neither timestamp is on the pdf sub-doc itself. */}
      <View style={styles.metaStrip}>
        <View style={styles.metaItem}>
          <User size={11} color={colors.textMuted} />
          <View>
            <Text style={styles.metaLabel}>UPLOADED BY</Text>
            <Text style={styles.metaValue} numberOfLines={1}>{inspection.uploader_name || inspection.updated_by || 'Seller'}</Text>
          </View>
        </View>
        <View style={styles.metaDivider} />
        <View style={styles.metaItem}>
          <Calendar size={11} color={colors.textMuted} />
          <View>
            <Text style={styles.metaLabel}>UPLOADED</Text>
            <Text style={styles.metaValue}>
              {formatAbsolute(inspection.uploaded_at || inspection.created_at || inspection.updated_at) || '—'}
            </Text>
          </View>
        </View>
        <View style={styles.metaDivider} />
        <View style={styles.metaItem}>
          <Clock size={11} color={colors.textMuted} />
          <View>
            <Text style={styles.metaLabel}>STATUS</Text>
            <Text style={[styles.metaValue, { color: colors.success }]}>
              {formatRelative(inspection.uploaded_at || inspection.created_at || inspection.updated_at) || 'Active'}
            </Text>
          </View>
        </View>
      </View>

      {/* Trust note */}
      <View style={styles.trustNote}>
        <ShieldCheck size={12} color={colors.success} />
        <Text style={styles.trustText}>Document securely served · auth-gated download</Text>
      </View>

      {/* Actions — responsive: primary keeps emphasis, both wrap to full
           width on narrow screens so labels never clip. */}
      <View style={styles.actions}>
        <TouchableOpacity
          onPress={() => open('view')}
          disabled={opening !== null}
          style={[styles.actionBtn, styles.actionPrimary]}
          testID="insp-pdf-view"
        >
          {opening === 'view'
            ? <ActivityIndicator color="#fff" />
            : <Eye size={16} color="#fff" strokeWidth={2.4} />}
          <Text style={styles.actionPrimaryText} numberOfLines={1} ellipsizeMode="tail">
            View Inspection Summary
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => open('download')}
          disabled={opening !== null}
          style={[styles.actionBtn, styles.actionSecondary]}
          testID="insp-pdf-download"
        >
          {opening === 'download'
            ? <ActivityIndicator color={colors.textChrome} />
            : <Download size={15} color={colors.textChrome} strokeWidth={2.2} />}
          <Text style={styles.actionSecondaryText} numberOfLines={1} ellipsizeMode="tail">
            Download PDF
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, padding: 14 },
  cardEmpty: {},
  cardVerified: { borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.04)' },

  headRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  iconBox: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  sub: { color: colors.textSecondary, fontSize: 11, marginTop: 4, lineHeight: 16 },
  sizeMeta: { color: colors.textMuted, fontSize: 11, marginTop: 4, fontWeight: '600' },

  metaStrip: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.bg, borderRadius: 10, padding: 12, marginTop: 14, borderWidth: 1, borderColor: colors.border },
  metaItem: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 },
  metaDivider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: colors.border, marginHorizontal: 8 },
  metaLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1, marginBottom: 1 },
  metaValue: { color: colors.textChrome, fontSize: 11, fontWeight: '700' },

  trustNote: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingHorizontal: 4 },
  trustText: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },

  // Action row — responsive: primary keeps emphasis on wider screens
  // (≥ ~340px usable width), wraps to its own row on narrow screens so the
  // "View Inspection Report" label is never clipped. flexBasis values are
  // tuned so the primary always gets enough width to show its full label.
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  actionBtn: {
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 52,                // premium touch target
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  actionPrimary: {
    flexBasis: 220,               // primary needs ~220px for full label;
    backgroundColor: colors.red,  // when row width < 220+8+140, it wraps
    shadowColor: colors.red,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.30,
    shadowRadius: 12,
    elevation: 6,
  },
  actionSecondary: {
    flexBasis: 140,               // secondary baseline; wraps below 280px
    backgroundColor: colors.bgDeep,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionPrimaryText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.3,
    flexShrink: 1,
    textAlign: 'center',
  },
  actionSecondaryText: {
    color: colors.textChrome,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.3,
    flexShrink: 1,
    textAlign: 'center',
  },
});
