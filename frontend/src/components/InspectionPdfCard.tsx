import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking, Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { FileText, Download, Eye, Upload, ShieldCheck, FileX, Clock } from 'lucide-react-native';
import { colors, radii } from '../theme';
import { api, inspectionPdfUrl } from '../api';
import { useToast } from '../toast';

type Props = {
  carId: string;
  inspection: any | null;
  isSeller: boolean;
  onUploaded: () => void;
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

export function InspectionPdfCard({ carId, inspection, isSeller, onUploaded }: Props) {
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState<'view' | 'download' | null>(null);

  const pickAndUpload = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled) return;
      const file = res.assets?.[0];
      if (!file) return;
      if (file.size && file.size > 10 * 1024 * 1024) {
        toast.show('PDF must be under 10 MB', 'error');
        return;
      }
      setUploading(true);
      await api.uploadInspection(carId, file.uri, file.name || 'inspection.pdf');
      toast.show('Inspection PDF attached', 'success');
      onUploaded();
    } catch (e: any) {
      toast.show(e.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  };

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

  if (!inspection) {
    if (isSeller) {
      return (
        <View style={[styles.card, styles.cardEmpty]}>
          <View style={styles.headRow}>
            <View style={[styles.iconBox, { backgroundColor: 'rgba(245,158,11,0.12)', borderColor: 'rgba(245,158,11,0.4)' }]}>
              <FileX size={18} color={colors.warning} />
            </View>
            <View style={{ flex: 1 }}>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: colors.warning }]} />
                <Text style={[styles.statusLabel, { color: colors.warning }]}>NO PDF ATTACHED</Text>
              </View>
              <Text style={styles.titleSeller}>Attach inspection report</Text>
              <Text style={styles.subSeller}>PDF reports drive 18% higher winning bids · max 10 MB</Text>
            </View>
          </View>
          <TouchableOpacity onPress={pickAndUpload} disabled={uploading} style={styles.primaryBtn} testID="insp-pdf-upload">
            {uploading ? <ActivityIndicator color="#fff" /> : <Upload size={16} color="#fff" />}
            <Text style={styles.primaryBtnText}>{uploading ? 'Uploading…' : 'Upload PDF report'}</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={[styles.card, styles.cardEmpty]}>
        <View style={styles.headRow}>
          <View style={[styles.iconBox, { backgroundColor: colors.bg, borderColor: colors.border }]}>
            <FileX size={18} color={colors.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: colors.textMuted }]} />
              <Text style={[styles.statusLabel, { color: colors.textMuted }]}>NOT ATTACHED</Text>
            </View>
            <Text style={styles.titleSeller}>Inspection PDF unavailable</Text>
            <Text style={styles.subSeller}>The seller hasn't uploaded a detailed inspection report yet.</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.card, styles.cardVerified]} testID="insp-pdf-card">
      <View style={styles.headRow}>
        <View style={[styles.iconBox, { backgroundColor: 'rgba(16,185,129,0.12)', borderColor: 'rgba(16,185,129,0.4)' }]}>
          <FileText size={18} color={colors.success} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.statusRow}>
            <ShieldCheck size={11} color={colors.success} />
            <Text style={[styles.statusLabel, { color: colors.success }]}>VERIFIED REPORT</Text>
          </View>
          <Text style={styles.title} numberOfLines={1}>{inspection.filename || 'inspection.pdf'}</Text>
          <View style={styles.metaRow}>
            <Clock size={11} color={colors.textMuted} />
            <Text style={styles.meta}>
              {formatBytes(inspection.size_bytes || 0)} · {inspection.version || 'v1'} · {formatRelative(inspection.created_at)}
            </Text>
          </View>
          <Text style={styles.uploader} numberOfLines={1}>Uploaded by {inspection.uploader_name || 'seller'}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity onPress={() => open('view')} disabled={opening !== null} style={[styles.actionBtn, styles.actionPrimary]} testID="insp-pdf-view">
          {opening === 'view' ? <ActivityIndicator color="#fff" /> : <Eye size={15} color="#fff" />}
          <Text style={styles.actionPrimaryText}>View PDF</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => open('download')} disabled={opening !== null} style={[styles.actionBtn, styles.actionSecondary]} testID="insp-pdf-download">
          {opening === 'download' ? <ActivityIndicator color={colors.textChrome} /> : <Download size={15} color={colors.textChrome} />}
          <Text style={styles.actionSecondaryText}>Download</Text>
        </TouchableOpacity>
      </View>

      {isSeller && (
        <TouchableOpacity onPress={pickAndUpload} disabled={uploading} style={styles.replaceBtn} testID="insp-pdf-replace">
          <Upload size={12} color={colors.textMuted} />
          <Text style={styles.replaceText}>{uploading ? 'Uploading…' : 'Replace with newer version'}</Text>
        </TouchableOpacity>
      )}
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
  titleSeller: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  subSeller: { color: colors.textSecondary, fontSize: 11, marginTop: 4, lineHeight: 16 },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  meta: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
  uploader: { color: colors.textMuted, fontSize: 10, marginTop: 4, fontWeight: '600' },

  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 10 },
  actionPrimary: { backgroundColor: colors.red },
  actionSecondary: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  actionPrimaryText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
  actionSecondaryText: { color: colors.textChrome, fontSize: 13, fontWeight: '700' },

  primaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.red, marginTop: 14 },
  primaryBtnText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },

  replaceBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8, marginTop: 6 },
  replaceText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
});
