/**
 * Inventory · Inspection Edit (post-launch)
 * ─────────────────────────────────────────────────────────────────
 * Operator-only screen reachable from the My Listings card. Loads
 * the canonical inspection record via GET /api/cars/{id}/inspection,
 * lets the operator edit every field (six sections + accident /
 * tyre / service free-text), and saves via PUT to the same path.
 *
 * The backend handles the heavy lifting:
 *   • Aggregation engine recomputes score / grade / liquidity
 *   • db.inspection_history audit row appended
 *   • Auction flagged `inspection_updated_after_launch=true` if live
 *   • WebSocket `inspection_updated` frame broadcast to every open
 *     lot screen so bidders see the new aggregates within a second
 *
 * This screen is a thin presentation layer over the canonical PUT —
 * no local "submit-only on launch" state, no AsyncStorage shadow
 * copy. The form ALWAYS reflects what GET returned (or what the
 * last PUT confirmed), keeping the single-source-of-truth invariant
 * intact between operator edits.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, Check, ShieldCheck, AlertCircle, Save, FileText, Camera,
} from 'lucide-react-native';
import { colors, radii } from '../../../src/theme';
import { api } from '../../../src/api';
import { useToast } from '../../../src/toast';

type SectionKey = 'exterior' | 'interior' | 'mechanical' | 'tyres' | 'documents' | 'photos';
type SectionState = {
  completed: boolean;
  score?: number;
  notes?: string;
  rc?: boolean;
  insurance?: boolean;
  puc?: boolean;
  photo_count?: number;
};

const SECTION_META: { key: SectionKey; label: string; sub: string; scored: boolean }[] = [
  { key: 'exterior',   label: 'Exterior',            sub: 'Paint, body panels, dents and scratches',     scored: true  },
  { key: 'interior',   label: 'Interior',            sub: 'Seats, dashboard, AC, infotainment',          scored: true  },
  { key: 'mechanical', label: 'Engine & Mechanical', sub: 'Engine, transmission, suspension',            scored: true  },
  { key: 'tyres',      label: 'Tyres & Wheels',      sub: 'Tread depth, alignment, alloy condition',     scored: true  },
  { key: 'documents',  label: 'Documents',           sub: 'RC, insurance, PUC certificate',              scored: false },
  { key: 'photos',     label: 'Photos',              sub: 'Front, back, sides, interior shots',          scored: false },
];

const SCORE_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

type FormState = {
  sections: Record<SectionKey, SectionState>;
  accident_history: string;
  tyre_condition: string;
  service_history: string;
};

const EMPTY_FORM: FormState = {
  sections: {
    exterior:   { completed: false },
    interior:   { completed: false },
    mechanical: { completed: false },
    tyres:      { completed: false },
    documents:  { completed: false, rc: false, insurance: false, puc: false },
    photos:     { completed: false, photo_count: 0 },
  },
  accident_history: '',
  tyre_condition:   '',
  service_history:  '',
};

function predictGrade(sections: Record<SectionKey, SectionState>): { score: number | null; grade: string | null; liquidity: string | null } {
  // Mirror of backend _aggregate_inspection — gives the operator an
  // instant grade preview before they save. Backend is the actual
  // source of truth; this is purely a UX confirmation.
  const scored: number[] = [];
  for (const s of Object.values(sections)) {
    const n = typeof s?.score === 'number' && s.score > 0 ? s.score : null;
    if (n !== null) scored.push(n);
  }
  if (scored.length === 0) return { score: null, grade: null, liquidity: null };
  const avg = Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10;
  const grade     = avg >= 9.0 ? 'A' : avg >= 8.0 ? 'B' : avg >= 7.0 ? 'C' : 'D';
  const liquidity = avg >= 8.5 ? 'HIGH' : avg >= 7.0 ? 'MEDIUM' : 'LOW';
  return { score: avg, grade, liquidity };
}

export default function InspectionEditScreen() {
  const { carId } = useLocalSearchParams<{ carId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();

  const [form, setForm]       = useState<FormState>(EMPTY_FORM);
  const [version, setVersion] = useState<number>(0);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!carId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getInspection(String(carId));
      const next: FormState = { ...EMPTY_FORM };
      // Defensive merge: backend returns a stable empty shape when
      // there's no record yet, so we can blindly spread sections.
      const incoming: Record<string, any> = (data.sections as any) || {};
      for (const k of Object.keys(EMPTY_FORM.sections) as SectionKey[]) {
        const s = incoming[k];
        if (s && typeof s === 'object') {
          next.sections[k] = {
            completed:   Boolean(s.completed),
            score:       typeof s.score === 'number' ? s.score : undefined,
            notes:       typeof s.notes === 'string' ? s.notes : undefined,
            rc:          typeof s.rc === 'boolean' ? s.rc : EMPTY_FORM.sections[k].rc,
            insurance:   typeof s.insurance === 'boolean' ? s.insurance : EMPTY_FORM.sections[k].insurance,
            puc:         typeof s.puc === 'boolean' ? s.puc : EMPTY_FORM.sections[k].puc,
            photo_count: typeof s.photo_count === 'number' ? s.photo_count : EMPTY_FORM.sections[k].photo_count,
          };
        }
      }
      next.accident_history = data.accident_history || '';
      next.tyre_condition   = data.tyre_condition   || '';
      next.service_history  = data.service_history  || '';
      setForm(next);
      setVersion(Number((data as any).version || 0));
      setUpdatedBy((data as any).updated_by || null);
      setUpdatedAt((data as any).updated_at || null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load inspection');
    } finally {
      setLoading(false);
    }
  }, [carId]);

  useEffect(() => { load(); }, [load]);

  const updateSection = useCallback(<K extends keyof SectionState>(key: SectionKey, field: K, value: SectionState[K]) => {
    setForm((prev) => ({
      ...prev,
      sections: { ...prev.sections, [key]: { ...prev.sections[key], [field]: value } },
    }));
  }, []);

  const preview = useMemo(() => predictGrade(form.sections), [form.sections]);

  const isEmpty = useMemo(() => {
    if (form.accident_history.trim() || form.tyre_condition.trim() || form.service_history.trim()) return false;
    for (const s of Object.values(form.sections)) {
      if (s.completed) return false;
      if (typeof s.score === 'number' && s.score > 0) return false;
      if ((s.notes || '').trim()) return false;
    }
    return true;
  }, [form]);

  const save = useCallback(async () => {
    if (!carId || saving) return;
    if (isEmpty) {
      toast.show('Inspection is empty — mark at least one section complete or add a note', 'error');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const sectionsForApi: Record<string, any> = {};
      for (const [k, v] of Object.entries(form.sections)) {
        const out: any = { completed: Boolean(v.completed) };
        if (typeof v.score === 'number' && v.score > 0) out.score = v.score;
        const notes = (v.notes || '').trim();
        if (notes) out.notes = notes;
        if (k === 'documents') {
          out.rc = Boolean(v.rc); out.insurance = Boolean(v.insurance); out.puc = Boolean(v.puc);
        }
        if (k === 'photos' && typeof v.photo_count === 'number') out.photo_count = v.photo_count;
        sectionsForApi[k] = out;
      }
      const res: any = await api.putInspection(String(carId), {
        sections: sectionsForApi,
        accident_history: form.accident_history.trim() || null,
        tyre_condition:   form.tyre_condition.trim()   || null,
        service_history:  form.service_history.trim()  || null,
      });
      toast.show(`Inspection saved · grade ${res?.condition_grade || '—'} · v${res?.version || version + 1}`, 'success');
      // Refresh the form with the backend's canonical response so
      // any normalisation (whitespace trim, derived grade etc.) is
      // reflected in the UI immediately.
      setVersion(Number(res?.version || version + 1));
      setUpdatedBy(res?.updated_by || updatedBy);
      setUpdatedAt(res?.updated_at || new Date().toISOString());
      // Brief delay so the operator sees the toast before nav back.
      setTimeout(() => router.back(), 600);
    } catch (e: any) {
      const msg = e?.message || 'Failed to save inspection';
      setError(msg);
      toast.show(msg, 'error');
    } finally {
      setSaving(false);
    }
  }, [carId, form, isEmpty, saving, router, toast, version, updatedBy]);

  if (loading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={colors.red} />
        <Text style={styles.loadingText}>Loading inspection…</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.root}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="insp-edit-back">
          <ArrowLeft size={18} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.kicker}>EDIT INSPECTION</Text>
          <Text style={styles.title} numberOfLines={1}>
            {version > 0 ? `Version ${version}` : 'New inspection'}
          </Text>
          {updatedBy && (
            <Text style={styles.subTitle} numberOfLines={1}>
              Last edited by {updatedBy}{updatedAt ? ` · ${new Date(updatedAt).toLocaleDateString()}` : ''}
            </Text>
          )}
        </View>
        {/* Live grade preview pill — recomputes as operator types. */}
        {preview.grade && (
          <View style={styles.gradePill}>
            <Text style={styles.gradePillScore}>{preview.score?.toFixed(1)}</Text>
            <Text style={styles.gradePillGrade}>Grade {preview.grade}</Text>
          </View>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
        keyboardShouldPersistTaps="handled"
      >
        {error && (
          <View style={styles.errorCard}>
            <AlertCircle size={14} color={colors.warning} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ── Per-section editing ────────────────────────────────── */}
        {SECTION_META.map(({ key, label, sub, scored }) => {
          const s = form.sections[key];
          const done = !!s.completed;
          return (
            <View key={key} style={[styles.sectionCard, done && styles.sectionDone]}>
              <View style={styles.sectionHead}>
                <View style={[styles.sectionDot, done && styles.sectionDotDone]}>
                  {done ? <Check size={14} color="#fff" strokeWidth={3} /> :
                          (key === 'photos' ? <Camera size={14} color={colors.textChrome} /> :
                                              <FileText size={14} color={colors.textChrome} />)}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionLabel}>{label}</Text>
                  <Text style={styles.sectionSub}>{sub}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => updateSection(key, 'completed', !done)}
                  style={[styles.completeChip, done && styles.completeChipOn]}
                  testID={`insp-${key}-toggle`}
                >
                  <Text style={[styles.completeChipText, done && { color: '#fff' }]}>
                    {done ? 'Completed' : 'Mark done'}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.sectionBody}>
                {scored && (
                  <>
                    <Text style={styles.fieldLabel}>Score / 10</Text>
                    <View style={styles.scoreRow}>
                      {SCORE_CHIPS.map((n) => {
                        const active = s.score === n;
                        return (
                          <TouchableOpacity
                            key={n}
                            onPress={() => updateSection(key, 'score', active ? undefined : n)}
                            style={[styles.scoreChip, active && styles.scoreChipActive]}
                            testID={`insp-${key}-score-${n}`}
                          >
                            <Text style={[styles.scoreChipText, active && { color: '#fff' }]}>{n}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </>
                )}

                {key === 'documents' && (
                  <View style={{ gap: 8 }}>
                    {(['rc', 'insurance', 'puc'] as const).map((doc) => (
                      <TouchableOpacity
                        key={doc}
                        onPress={() => updateSection(key, doc, !s[doc])}
                        style={[styles.docRow, s[doc] && styles.docRowChecked]}
                        testID={`insp-doc-${doc}`}
                      >
                        <View style={[styles.checkbox, s[doc] && styles.checkboxChecked]}>
                          {s[doc] && <Check size={12} color="#fff" strokeWidth={3} />}
                        </View>
                        <Text style={styles.docLabel}>{doc.toUpperCase()}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {key === 'photos' && (
                  <>
                    <Text style={styles.fieldLabel}>Photos captured</Text>
                    <TextInput
                      value={String(s.photo_count ?? 0)}
                      onChangeText={(v) => updateSection(key, 'photo_count', Math.max(0, Math.min(99, parseInt(v.replace(/\D/g, '') || '0', 10))))}
                      keyboardType="number-pad"
                      style={[styles.textInput, { width: 100 }]}
                      testID="insp-photos-count"
                    />
                  </>
                )}

                <Text style={styles.fieldLabel}>Notes (optional)</Text>
                <TextInput
                  value={s.notes || ''}
                  onChangeText={(v) => updateSection(key, 'notes', v)}
                  placeholder="Add details bidders should know"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  style={styles.textarea}
                  maxLength={300}
                  testID={`insp-${key}-notes`}
                />
              </View>
            </View>
          );
        })}

        {/* ── Top-level free-text fields ───────────────────────────── */}
        <View style={[styles.sectionCard, { marginTop: 4 }]}>
          <View style={styles.sectionHead}>
            <View style={styles.sectionDot}>
              <FileText size={14} color={colors.textChrome} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionLabel}>Disclosures & history</Text>
              <Text style={styles.sectionSub}>Buyer-critical free text</Text>
            </View>
          </View>
          <View style={styles.sectionBody}>
            <Text style={styles.fieldLabel}>Accident history</Text>
            <TextInput
              value={form.accident_history}
              onChangeText={(v) => setForm((p) => ({ ...p, accident_history: v }))}
              placeholder='Blank if no accidents · or describe e.g. "Front bumper repaired Mar 2024"'
              placeholderTextColor={colors.textMuted}
              multiline
              style={styles.textarea}
              maxLength={500}
              testID="insp-accident-history"
            />

            <Text style={styles.fieldLabel}>Tyre condition</Text>
            <TextInput
              value={form.tyre_condition}
              onChangeText={(v) => setForm((p) => ({ ...p, tyre_condition: v }))}
              placeholder='e.g. "Excellent · 6 mm tread all round"'
              placeholderTextColor={colors.textMuted}
              style={styles.textInput}
              maxLength={120}
              testID="insp-tyre-condition"
            />

            <Text style={styles.fieldLabel}>Service history</Text>
            <TextInput
              value={form.service_history}
              onChangeText={(v) => setForm((p) => ({ ...p, service_history: v }))}
              placeholder='e.g. "Authorised dealer — full service every 10K"'
              placeholderTextColor={colors.textMuted}
              style={styles.textInput}
              maxLength={140}
              testID="insp-service-history"
            />
          </View>
        </View>

        <Text style={styles.helperText}>
          Saving triggers a live update for every bidder watching this listing. The auction
          is automatically flagged "Inspection updated" so dealers know to re-read the report.
        </Text>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity
          onPress={save}
          disabled={saving || isEmpty}
          style={[styles.saveBtn, (saving || isEmpty) && styles.saveBtnDisabled]}
          testID="insp-save-btn"
        >
          {saving ? <ActivityIndicator color="#fff" /> : <Save size={16} color="#fff" />}
          <Text style={styles.saveBtnText}>
            {saving ? 'Saving…' : isEmpty ? 'Add content to save' : (version > 0 ? 'Save changes' : 'Save inspection')}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: colors.textMuted, fontSize: 13, marginTop: 12, fontWeight: '600' },

  header: { flexDirection: 'row', alignItems: 'center', padding: 16, paddingTop: 56 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  kicker: { color: colors.red, fontSize: 10, fontWeight: '900', letterSpacing: 1.6 },
  title:  { color: colors.textPrimary, fontSize: 18, fontWeight: '800', marginTop: 2, letterSpacing: -0.3 },
  subTitle: { color: colors.textMuted, fontSize: 11, marginTop: 2, fontWeight: '600' },

  gradePill: {
    alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
    backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(16,185,129,0.4)', borderWidth: 1,
  },
  gradePillScore: { color: colors.success, fontSize: 14, fontWeight: '900' },
  gradePillGrade: { color: colors.success, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginTop: 1 },

  scroll: { padding: 16, gap: 10 },

  errorCard: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, backgroundColor: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.4)', borderWidth: 1, borderRadius: radii.md },
  errorText: { color: colors.warning, fontSize: 12, fontWeight: '600', flex: 1 },

  sectionCard: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, overflow: 'hidden' },
  sectionDone: { borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.04)' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  sectionDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  sectionDotDone: { backgroundColor: colors.success, borderColor: colors.success },
  sectionLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  sectionSub:   { color: colors.textSecondary, fontSize: 11, marginTop: 2 },
  completeChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1 },
  completeChipOn: { backgroundColor: colors.success, borderColor: colors.success },
  completeChipText: { color: colors.textChrome, fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },

  sectionBody: { padding: 14, paddingTop: 4, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, gap: 10 },

  fieldLabel: { color: colors.textSecondary, fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  scoreRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  scoreChip: { width: 36, paddingVertical: 8, alignItems: 'center', backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 8 },
  scoreChipActive: { backgroundColor: colors.red, borderColor: colors.red },
  scoreChipText:   { color: colors.textChrome, fontSize: 13, fontWeight: '800' },
  textInput: { minHeight: 44, color: colors.textPrimary, fontSize: 13, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 10 },
  textarea:  { minHeight: 68, color: colors.textPrimary, fontSize: 13, padding: 12, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 10, textAlignVertical: 'top' },

  docRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: 10 },
  docRowChecked: { borderColor: 'rgba(16,185,129,0.35)', backgroundColor: 'rgba(16,185,129,0.06)' },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderColor: colors.border, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: colors.success, borderColor: colors.success },
  docLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },

  helperText: { color: colors.textMuted, fontSize: 11, fontWeight: '500', marginTop: 4, lineHeight: 16 },

  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: 14, backgroundColor: colors.bgElevated,
    borderTopColor: colors.border, borderTopWidth: 1,
  },
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: radii.md, backgroundColor: colors.red,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8,
  },
  saveBtnDisabled: { backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, shadowOpacity: 0 },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
});
