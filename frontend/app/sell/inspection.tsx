import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import {
  ArrowLeft, ChevronDown, ChevronUp, Check, ShieldCheck, FileCheck2, Camera,
  TrendingUp, FileText, X as XIcon, Upload,
} from 'lucide-react-native';
import { colors, radii } from '../../src/theme';
import { useInspection, SECTIONS, SectionKey, inspectionStats, SectionState } from '../../src/inspection';
import { useToast } from '../../src/toast';

export default function InspectionForm() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { draft, pdfDraft, updateSection, completeSection, setPdfDraft } = useInspection();
  const toast = useToast();
  const [expanded, setExpanded] = useState<SectionKey | null>(SECTIONS[0].key);

  const stats = inspectionStats(draft);
  const isDone = stats.status === 'completed';

  const toggle = (k: SectionKey) => setExpanded((cur) => (cur === k ? null : k));

  const onCompleteSection = (k: SectionKey) => {
    completeSection(k);
    const idx = SECTIONS.findIndex((s) => s.key === k);
    const next = SECTIONS[idx + 1];
    toast.show(`${SECTIONS[idx].label} marked complete`, 'success');
    setExpanded(next ? next.key : null);
  };

  const finish = () => {
    if (!isDone) {
      toast.show(`Complete all ${stats.total} sections to finish`, 'info');
      return;
    }
      toast.show('Inspection summary attached to your listing', 'success');
    router.back();
  };

  const pickPdf = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (res.canceled) return;
      const f = res.assets?.[0];
      if (!f) return;
      if (f.size && f.size > 10 * 1024 * 1024) {
        toast.show('PDF must be under 10 MB', 'error');
        return;
      }
      setPdfDraft({ uri: f.uri, name: f.name || 'inspection.pdf', size: f.size });
      toast.show('PDF attached to draft · uploads on launch', 'success');
    } catch (e: any) {
      toast.show(e.message || 'Failed to attach PDF', 'error');
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="insp-back">
          <ArrowLeft size={20} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={styles.kicker}>INSPECTION REPORT</Text>
          <Text style={styles.title}>Build dealer trust</Text>
        </View>
        <View style={styles.percentPill}>
          <Text style={styles.percentText}>{stats.percent}%</Text>
        </View>
      </View>

      {/* Progress bar */}
      <View style={styles.progressWrap}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${stats.percent}%` }]} />
        </View>
        <Text style={styles.progressLabel}>{stats.completed} of {stats.total} sections complete</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 120 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Trust note */}
        <View style={styles.trustCallout}>
          <TrendingUp size={16} color={colors.success} />
          <Text style={styles.trustText}>
            Verified inspection reports get <Text style={styles.trustHi}>up to 18% higher</Text> winning bids on Q Drives.
          </Text>
        </View>

        {SECTIONS.map((s, i) => {
          const state = draft[s.key];
          const isExpanded = expanded === s.key;
          const done = state?.completed;
          return (
            <View key={s.key} style={[styles.sectionCard, done && styles.sectionDone]}>
              <TouchableOpacity onPress={() => toggle(s.key)} style={styles.sectionHead} testID={`insp-section-${s.key}`}>
                <View style={[styles.sectionDot, done && styles.sectionDotDone]}>
                  {done ? <Check size={14} color="#fff" strokeWidth={3} /> : <Text style={styles.sectionNum}>{i + 1}</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.sectionLabel, done && { color: colors.success }]}>{s.label}</Text>
                  <Text style={styles.sectionSub}>{s.description}</Text>
                </View>
                {isExpanded ? <ChevronUp size={18} color={colors.textChrome} /> : <ChevronDown size={18} color={colors.textChrome} />}
              </TouchableOpacity>

              {isExpanded && (
                <View style={styles.sectionBody}>
                  {s.key === 'documents' ? (
                    <DocumentsForm state={state} onChange={(p) => updateSection(s.key, p)} />
                  ) : s.key === 'photos' ? (
                    <PhotosForm state={state} onChange={(p) => updateSection(s.key, p)} />
                  ) : (
                    <ScoreForm state={state} onChange={(p) => updateSection(s.key, p)} placeholder={`Notes about ${s.label.toLowerCase()}…`} />
                  )}

                  <TouchableOpacity
                    onPress={() => onCompleteSection(s.key)}
                    style={[styles.completeBtn, done && { opacity: 0.55 }]}
                    disabled={done}
                    testID={`insp-complete-${s.key}`}
                  >
                    <Check size={14} color="#fff" />
                    <Text style={styles.completeText}>{done ? 'Completed' : `Mark ${s.label} complete`}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })}

        {/* Optional PDF attachment — uploaded on auction launch */}
        <View style={[styles.sectionCard, pdfDraft && styles.sectionDone, { marginTop: 4 }]}>
          <View style={styles.sectionHead}>
            <View style={[styles.sectionDot, pdfDraft && styles.sectionDotDone]}>
              {pdfDraft ? <Check size={14} color="#fff" strokeWidth={3} /> : <FileText size={14} color={colors.textChrome} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionLabel, pdfDraft && { color: colors.success }]}>Inspection PDF (optional)</Text>
              <Text style={styles.sectionSub}>Detailed audit document — buyers can download it</Text>
            </View>
          </View>
          <View style={styles.sectionBody}>
            {pdfDraft ? (
              <View style={styles.pdfRow}>
                <View style={styles.pdfIcon}><FileText size={18} color={colors.success} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pdfName} numberOfLines={1}>{pdfDraft.name}</Text>
                  <Text style={styles.pdfSize}>
                    {pdfDraft.size ? `${(pdfDraft.size / 1024).toFixed(0)} KB` : 'Ready'} · uploads when auction launches
                  </Text>
                </View>
                <TouchableOpacity onPress={() => { setPdfDraft(null); toast.show('PDF removed', 'info'); }} style={styles.pdfClear} testID="insp-pdf-remove">
                  <XIcon size={16} color={colors.textChrome} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={pickPdf} style={styles.pickBtn} testID="insp-pick-pdf">
                <Upload size={15} color={colors.red} />
                <Text style={styles.pickText}>Attach inspection PDF · max 10 MB</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Sticky finish CTA */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity onPress={finish} style={[styles.finishBtn, !isDone && styles.finishBtnInactive]} testID="insp-finish-btn">
          {isDone ? <ShieldCheck size={18} color="#fff" /> : <FileCheck2 size={18} color={colors.textChrome} />}
          <Text style={[styles.finishText, !isDone && { color: colors.textChrome }]}>
            {isDone ? 'Save inspection report' : `Continue inspection · ${stats.percent}%`}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function ScoreForm({ state, onChange, placeholder }: { state?: SectionState; onChange: (p: Partial<SectionState>) => void; placeholder: string }) {
  const score = state?.score ?? 8;
  return (
    <View style={{ gap: 14 }}>
      <Text style={styles.fieldLabel}>Self-assessment score</Text>
      <View style={styles.scoreRow}>
        {[6, 7, 8, 9, 10].map((s) => (
          <TouchableOpacity key={s} onPress={() => onChange({ score: s })} style={[styles.scoreChip, score === s && styles.scoreChipActive]}>
            <Text style={[styles.scoreChipText, score === s && { color: '#fff' }]}>{s}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.fieldLabel}>Notes</Text>
      <TextInput
        value={state?.notes || ''}
        onChangeText={(notes) => onChange({ notes })}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline
        style={styles.textarea}
      />
    </View>
  );
}

function DocumentsForm({ state, onChange }: { state?: SectionState; onChange: (p: Partial<SectionState>) => void }) {
  const items: { k: 'rc' | 'insurance' | 'puc'; label: string; sub: string }[] = [
    { k: 'rc',        label: 'RC verified',       sub: 'Registration certificate active' },
    { k: 'insurance', label: 'Insurance current', sub: 'Comprehensive cover not expired' },
    { k: 'puc',       label: 'PUC certificate',   sub: 'Pollution under control valid' },
  ];
  return (
    <View style={{ gap: 8 }}>
      {items.map((it) => {
        const checked = !!state?.[it.k];
        return (
          <TouchableOpacity key={it.k} onPress={() => onChange({ [it.k]: !checked })} style={[styles.docRow, checked && styles.docRowChecked]}>
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
              {checked && <Check size={12} color="#fff" strokeWidth={3} />}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.docLabel}>{it.label}</Text>
              <Text style={styles.docSub}>{it.sub}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function PhotosForm({ state, onChange }: { state?: SectionState; onChange: (p: Partial<SectionState>) => void }) {
  const count = state?.photoCount ?? 0;
  const slots = ['Front', 'Back', 'Side', 'Interior'];
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.fieldLabel}>Required photos</Text>
      <View style={styles.photoGrid}>
        {slots.map((label, i) => {
          const filled = i < count;
          return (
            <TouchableOpacity
              key={label}
              onPress={() => onChange({ photoCount: filled ? count - 1 : Math.min(slots.length, count + 1) })}
              style={[styles.photoCell, filled && styles.photoCellFilled]}
            >
              {filled ? <Check size={20} color={colors.success} /> : <Camera size={18} color={colors.textChrome} />}
              <Text style={styles.photoLabel}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.helperText}>{count}/{slots.length} captured · tap to toggle (stock gallery used in dev)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14 },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  kicker: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  title: { color: colors.textPrimary, fontSize: 20, fontWeight: '800', marginTop: 2, letterSpacing: -0.4 },
  percentPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.12)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)' },
  percentText: { color: colors.red, fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },

  progressWrap: { paddingHorizontal: 20, marginBottom: 8 },
  progressTrack: { height: 6, backgroundColor: colors.bgCard, borderRadius: 3, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  progressFill: { height: '100%', backgroundColor: colors.red, borderRadius: 3 },
  progressLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, marginTop: 8 },

  scroll: { padding: 20, gap: 10 },

  trustCallout: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, backgroundColor: 'rgba(16,185,129,0.06)', borderColor: 'rgba(16,185,129,0.3)', borderWidth: 1, borderRadius: radii.md, marginBottom: 8 },
  trustText: { color: colors.textChrome, fontSize: 12, lineHeight: 18, flex: 1, fontWeight: '500' },
  trustHi: { color: colors.success, fontWeight: '800' },

  sectionCard: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, overflow: 'hidden' },
  sectionDone: { borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.04)' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  sectionDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sectionDotDone: { backgroundColor: colors.success, borderColor: colors.success },
  sectionNum: { color: colors.textChrome, fontSize: 12, fontWeight: '800' },
  sectionLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  sectionSub: { color: colors.textSecondary, fontSize: 11, marginTop: 2 },

  sectionBody: { padding: 14, paddingTop: 4, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, gap: 14 },

  fieldLabel: { color: colors.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  scoreRow: { flexDirection: 'row', gap: 6 },
  scoreChip: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 10 },
  scoreChipActive: { backgroundColor: colors.red, borderColor: colors.red },
  scoreChipText: { color: colors.textChrome, fontSize: 14, fontWeight: '800' },
  textarea: { minHeight: 70, color: colors.textPrimary, fontSize: 13, padding: 12, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 10, textAlignVertical: 'top' },

  docRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 10 },
  docRowChecked: { borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.06)' },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderColor: colors.border, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.success, borderColor: colors.success },
  docLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  docSub: { color: colors.textMuted, fontSize: 11, marginTop: 1 },

  photoGrid: { flexDirection: 'row', gap: 8 },
  photoCell: { flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 12, borderStyle: 'dashed' },
  photoCellFilled: { borderColor: 'rgba(16,185,129,0.4)', backgroundColor: 'rgba(16,185,129,0.06)', borderStyle: 'solid' },
  photoLabel: { color: colors.textMuted, fontSize: 10, fontWeight: '700' },
  helperText: { color: colors.textMuted, fontSize: 10, fontWeight: '600' },

  completeBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, backgroundColor: colors.red, borderRadius: 10 },
  completeText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 0.4 },

  footer: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, backgroundColor: colors.bgElevated, borderTopColor: colors.border, borderTopWidth: 1 },
  finishBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, borderRadius: radii.md, backgroundColor: colors.red, shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  finishBtnInactive: { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, shadowOpacity: 0 },
  finishText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },

  pdfRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: 'rgba(16,185,129,0.06)', borderColor: 'rgba(16,185,129,0.3)', borderWidth: 1, borderRadius: 10 },
  pdfIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: 'rgba(16,185,129,0.12)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)', alignItems: 'center', justifyContent: 'center' },
  pdfName: { color: colors.textPrimary, fontSize: 13, fontWeight: '700' },
  pdfSize: { color: colors.textMuted, fontSize: 11, marginTop: 2, fontWeight: '600' },
  pdfClear: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  pickBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, backgroundColor: 'rgba(185,28,28,0.10)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)', borderStyle: 'dashed' },
  pickText: { color: colors.red, fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
});
