import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Sparkles, Clock, ArrowRight, ShieldCheck, ChevronRight, FileCheck2,
  FlaskConical, Save, Trash2, AlertCircle, ImagePlus,
} from 'lucide-react-native';
import { colors, radii, formatINRFull, formatINR } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';
import { useInspection, inspectionStats } from '../../src/inspection';
import { storage } from '../../src/storage';
import { Select } from '../../src/components/Select';
import { useAuth } from '../../src/auth';

const FUEL = ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'];
const TRANS = ['Manual', 'Automatic', 'AMT', 'CVT', 'DCT'];
const OWNER_OPTIONS = [
  { label: '1st Owner', value: 1 },
  { label: '2nd Owner', value: 2 },
  { label: '3rd Owner', value: 3 },
  { label: '4th Owner', value: 4 },
  { label: '5+ Owners', value: 5 },
];

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 30 }, (_, i) => CURRENT_YEAR - i);

const DRAFT_KEY = 'qdrives_listing_draft_v1';
// Demo RC data — used for the "Auto-fill from RC" smoke test in dev.
// CRITICAL: every field must match FormShape exactly. Mixing in a raw
// number for km_driven (which is typed as `string` for free typing)
// caused a hard crash in launch() the moment the operator tapped Save
// — `form.km_driven.replace` was suddenly not a function. We now keep
// km_driven as a string AND pass everything through coerceFormShape()
// before merging into state, as belt-and-braces defence.
const DEMO_RC_DATA = {
  registration_number: 'MH02AB1234',
  make: 'Hyundai',
  model: 'Tucson',
  variant: 'Signature',
  manufacturing_year: 2022,
  registration_year: 2022,
  fuel_type: 'Petrol',
  transmission: 'Automatic',
  km_driven: '24800',
  color: 'Phantom Black',
  owners: 1,
  insurance_validity: '08/2026',
  rto_details: 'MH02 - Mumbai West',
};

// ---------------------------------------------------------------------
// Defensive typing helpers
// ---------------------------------------------------------------------
// The form was crashing in production with `form.km_driven.replace is
// not a function` because the persisted draft (and the demo RC data
// auto-fill) sometimes contained numbers / nulls where the FormShape
// expects strings. We never want a single bad field to break the entire
// operator pipeline, so all numeric-string fields are normalised at
// every state boundary (mount → draft restore → demo fill → setForm).
//
// Rules:
//   • `km_driven` is a *string* (free typing) — coerce numbers, nulls,
//     undefined → string. Strip non-digits at coerce time so even a
//     pasted "24,800 km" turns into "24800".
//   • Numeric int fields (starting_bid, reserve_price, owners,
//     duration_minutes, years) get Number()-cast or fallback to the
//     EMPTY_FORM value.
//   • Trimmed-string fields fall back to empty string.

const safeStringDigits = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[^0-9]/g, '');
};
const safeString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
};
const safeIntOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9.-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};
const safeInt = (v: unknown, fallback: number): number => {
  const n = safeIntOrNull(v);
  return n === null ? fallback : n;
};

/**
 * Coerce ANY object into a valid FormShape. Used at every mutation
 * entry point (initial state, draft restore, demo auto-fill, update
 * handler) so the rest of the screen can call `.replace`, parseInt,
 * etc. without crashing on a malformed value.
 */
function coerceFormShape(input: Partial<Record<keyof FormShape, any>>): FormShape {
  return {
    registration_number: safeString(input.registration_number).toUpperCase().replace(/\s+/g, ''),
    make:                safeString(input.make),
    model:               safeString(input.model),
    variant:             safeString(input.variant),
    manufacturing_year:  safeIntOrNull(input.manufacturing_year),
    registration_year:   safeIntOrNull(input.registration_year),
    fuel_type:           safeString(input.fuel_type),
    transmission:        safeString(input.transmission),
    // CRITICAL — must remain a string so `.replace` works downstream.
    km_driven:           safeStringDigits(input.km_driven),
    color:               safeString(input.color),
    owners:              safeInt(input.owners, 1),
    insurance_validity:  safeString(input.insurance_validity),
    rto_details:         safeString(input.rto_details),
    notes:               safeString(input.notes),
    starting_bid:        safeInt(input.starting_bid, 0),
    reserve_price:       safeInt(input.reserve_price, 0),
    duration_minutes:    safeInt(input.duration_minutes, 60),
  };
}

type FormShape = {
  registration_number: string;
  make: string;
  model: string;
  variant: string;
  manufacturing_year: number | null;
  registration_year: number | null;
  fuel_type: string;
  transmission: string;
  km_driven: string; // text for free typing, parsed on submit
  color: string;
  owners: number;
  insurance_validity: string;
  rto_details: string;
  notes: string;
  starting_bid: number;
  reserve_price: number;
  duration_minutes: number;
};

const EMPTY_FORM: FormShape = {
  registration_number: '',
  make: '',
  model: '',
  variant: '',
  manufacturing_year: null,
  registration_year: null,
  fuel_type: '',
  transmission: '',
  km_driven: '',
  color: '',
  owners: 1,
  insurance_validity: '',
  rto_details: '',
  notes: '',
  starting_bid: 0,
  reserve_price: 0,
  duration_minutes: 60,
};

type Errors = Partial<Record<keyof FormShape, string>>;

function validate(form: FormShape): Errors {
  const e: Errors = {};
  if (!safeString(form.registration_number).trim() || safeString(form.registration_number).trim().length < 6) {
    e.registration_number = 'Enter a valid registration number';
  }
  if (!safeString(form.make).trim()) e.make = 'Required';
  if (!safeString(form.model).trim()) e.model = 'Required';
  if (!form.manufacturing_year) e.manufacturing_year = 'Required';
  if (!form.registration_year) e.registration_year = 'Required';
  if (
    form.manufacturing_year && form.registration_year &&
    form.registration_year < form.manufacturing_year
  ) {
    e.registration_year = 'Cannot be before manufacturing year';
  }
  if (!form.fuel_type) e.fuel_type = 'Required';
  if (!form.transmission) e.transmission = 'Required';
  // Use safeStringDigits so a number / null / undefined km_driven
  // (from a stale draft or RC autofill that bypassed coercion) cannot
  // crash this validator — it gets stringified first.
  const km = parseInt(safeStringDigits(form.km_driven), 10);
  if (!km || km < 1) e.km_driven = 'Enter a valid number';
  else if (km > 1_000_000) e.km_driven = 'Looks too high';
  if (!form.starting_bid || form.starting_bid < 50000) e.starting_bid = 'Min ₹50,000';
  if (!form.reserve_price || form.reserve_price < form.starting_bid) {
    e.reserve_price = 'Reserve must be ≥ starting bid';
  }
  if (form.insurance_validity) {
    const ok = /^(\d{2})\/(\d{4})$/.test(safeString(form.insurance_validity).trim());
    if (!ok) e.insurance_validity = 'Use MM/YYYY';
  }
  return e;
}

export default function Sell() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { dealer } = useAuth();
  const { draft, pdfDraft, setPdfDraft } = useInspection();
  const inspStats = inspectionStats(draft);

  // Admin-only access — non-admin dealers cannot create listings
  if (dealer && !['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(dealer.role as any)) {
    return <Redirect href="/(tabs)/" />;
  }

  const [form, setForm] = useState<FormShape>(EMPTY_FORM);
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState<Set<keyof FormShape>>(new Set());
  const [estimating, setEstimating] = useState(false);
  const [aiEst, setAiEst] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const saveTimer = useRef<any>(null);

  // ---- Draft persistence ----
  useEffect(() => {
    (async () => {
      try {
        const raw = await storage.getItem(DRAFT_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            // Coerce — older drafts may have stored km_driven as a
            // number (bug we shipped before this fix) which would
            // crash `.replace()` on the very next render. Normalise
            // every field through the type guard before committing
            // it to state.
            setForm(coerceFormShape({ ...EMPTY_FORM, ...parsed }));
            setDraftRestored(true);
          }
        }
      } catch {}
    })();
  }, []);

  // Debounced auto-save (1s after last keystroke)
  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      // skip empty
      const isEmpty = !form.registration_number && !form.make && !form.model && !form.km_driven;
      if (isEmpty) return;
      try {
        await storage.setItem(DRAFT_KEY, JSON.stringify(form));
        setSavedAt(Date.now());
      } catch {}
    }, 1000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [form]);

  const u = (k: keyof FormShape, v: any) => {
    // Re-coerce on every update — this guarantees that even if a
    // caller (RC API mock, AI price estimate, etc.) passes a wrong-
    // typed value, the form state stays type-clean.
    setForm((p) => coerceFormShape({ ...p, [k]: v }));
    if (touched.has(k)) {
      // re-validate this field on each keystroke once touched
      setErrors((prev) => {
        const next = validate(coerceFormShape({ ...form, [k]: v }));
        return { ...prev, [k]: next[k] };
      });
    }
  };
  const markTouched = (k: keyof FormShape) =>
    setTouched((s) => (s.has(k) ? s : new Set(s).add(k)));

  // ---- Demo RC autofill (clearly labeled) ----
  const useDemoData = () => {
    // DEMO_RC_DATA was the historic crash source — km_driven was a
    // raw number. coerceFormShape now stringifies it before it ever
    // hits state, but we keep the fix defence-in-depth at the merge
    // site too.
    setForm((p) => coerceFormShape({ ...p, ...DEMO_RC_DATA }));
    setErrors({});
    setTouched(new Set());
    toast.show('Demo data loaded. This is mock data, not a real RC lookup.', 'info');
  };

  const clearForm = async () => {
    setForm(EMPTY_FORM);
    setErrors({});
    setTouched(new Set());
    setAiEst(null);
    try { await storage.removeItem(DRAFT_KEY); } catch {}
    setDraftRestored(false);
    setSavedAt(null);
    toast.show('Draft cleared', 'success');
  };

  // ---- Wholesale Valuation Engine (deterministic price band) ----
  const canEstimate = !!form.make && !!form.model && !!form.registration_year && !!form.km_driven;
  const estimate = async () => {
    if (!canEstimate) {
      toast.show('Fill make, model, year and kms first', 'error');
      return;
    }
    setEstimating(true);
    try {
      const res = await api.priceEstimate({
        make: form.make,
        model: form.model,
        year: form.registration_year,
        km_driven: parseInt(safeStringDigits(form.km_driven), 10) || 0,
        fuel_type: form.fuel_type || 'Petrol',
        owners: form.owners,
        condition_score: 8.5,
      });
      setAiEst(res);
      const start = Math.max(50000, Math.round(((res as any).market_low_inr || 1000000) * 0.95 / 1000) * 1000);
      const reserve = Math.round(((res as any).estimated_price_inr || 1200000) / 1000) * 1000;
      setForm((p) => coerceFormShape({ ...p, starting_bid: start, reserve_price: reserve }));
      toast.show('Valuation ready', 'success');
    } catch (e: any) {
      toast.show(e.message || 'Valuation failed', 'error');
    } finally {
      setEstimating(false);
    }
  };

  // Friendly human-readable labels for each form field — surfaced in
  // validation errors so the operator knows EXACTLY which field is
  // blocking submission instead of a generic "Fix the highlighted fields".
  const FIELD_LABELS: Record<keyof FormShape, string> = {
    registration_number: 'Registration number',
    make: 'Make', model: 'Model', variant: 'Variant',
    manufacturing_year: 'Manufacturing year',
    registration_year: 'Registration year',
    fuel_type: 'Fuel type', transmission: 'Transmission',
    km_driven: 'Kilometers driven', color: 'Color', owners: 'Owners',
    insurance_validity: 'Insurance validity',
    rto_details: 'RTO details', notes: 'Notes',
    starting_bid: 'Starting bid', reserve_price: 'Reserve price',
    duration_minutes: 'Duration',
  };

  // ---- Create draft → route to media manager ----
  // The new flow: this screen creates a DRAFT auction (no images yet), then
  // routes the operator straight to the per-car Media Manager so they can
  // upload + organise photos. The auction only becomes "live" after the
  // operator taps Launch from the media manager (which calls
  // /api/admin/auctions/{id}/launch with hard-gated readiness checks).
  //
  // INSTRUMENTATION (P0): every step is loud — console-traced + toasted.
  // No silent failures: validation errors name the failing fields, role
  // mismatches are surfaced, API exceptions are shown verbatim, and the
  // post-create navigation hop is logged so we can diagnose any future
  // "button does nothing" reports without guessing.
  const launch = async () => {
    const t0 = Date.now();
    // eslint-disable-next-line no-console
    console.log('[sell.launch] tapped', { role: dealer?.role, ts: t0 });

    // ── Step 1: Role gate. Should never trigger because the screen
    // itself is role-gated above, but a belt-and-braces check protects
    // against state-race conditions (e.g. token refresh swapping role).
    const role = dealer?.role;
    if (!role || !['admin', 'super_admin', 'operations_admin', 'inspection_admin'].includes(role as any)) {
      const msg = `Only operators can create listings (your role: ${role || 'unknown'})`;
      console.warn('[sell.launch] role-blocked', { role });
      toast.show(msg, 'error');
      return;
    }

    // ── Step 2: Field validation. Show ALL failing fields by name so
    // the operator can fix them in one pass instead of trial-and-error.
    const e = validate(form);
    setErrors(e);
    setTouched(new Set(Object.keys(form) as (keyof FormShape)[]));
    if (Object.keys(e).length) {
      const fieldList = (Object.keys(e) as (keyof FormShape)[])
        .map((k) => FIELD_LABELS[k] || String(k))
        .slice(0, 4)
        .join(', ');
      const more = Object.keys(e).length > 4 ? ` (+${Object.keys(e).length - 4} more)` : '';
      const msg = `Fix: ${fieldList}${more}`;
      console.warn('[sell.launch] validation-failed', e);
      toast.show(msg, 'error');
      return;
    }

    // ── Step 3: Inspection-completion gate. The previous flow silently
    // redirected to /sell/inspection which felt like "the button does
    // nothing". Now we show an explicit toast first AND log it so the
    // operator knows exactly why they're being moved.
    if (inspStats.status !== 'completed') {
      const pct = inspStats.percent;
      const msg = `Inspection ${pct}% complete — finish all 6 sections to unlock Launch`;
      console.warn('[sell.launch] inspection-incomplete', { status: inspStats.status, percent: pct, completed: inspStats.completed, total: inspStats.total });
      toast.show(msg, 'error');
      // Give the user time to read the toast before navigating away.
      setTimeout(() => router.push('/sell/inspection'), 600);
      return;
    }

    // ── Step 4: Build payload + hit the API.
    setCreating(true);
    // safeStringDigits is paranoid — even if a stale draft restored
    // a number into km_driven, this normalises to string-of-digits
    // before parseInt, so the launch button can never crash with
    // "form.km_driven.replace is not a function".
    const km = parseInt(safeStringDigits(form.km_driven), 10);
    if (!km || km < 1) {
      // Belt-and-braces: validate() already caught this, but if a
      // type-clobbered draft slipped through, surface a clear toast
      // instead of sending `NaN` to the backend.
      setCreating(false);
      console.warn('[sell.launch] km_driven failed final coercion', form.km_driven);
      toast.show('Kilometers driven is invalid — please re-enter', 'error');
      return;
    }
    // Defensive: every string field is run through safeString() before
    // `.trim()`. Even if some upstream caller (RC autofill, AI
    // estimate, deep-link) shoved a non-string into state, we can no
    // longer crash here.
    const payload = {
      registration_number: safeString(form.registration_number).trim().toUpperCase(),
      make:                safeString(form.make).trim(),
      model:               safeString(form.model).trim(),
      variant:             safeString(form.variant).trim(),
      year:                form.registration_year,
      manufacturing_year:  form.manufacturing_year,
      registration_year:   form.registration_year,
      fuel_type:           safeString(form.fuel_type),
      transmission:        safeString(form.transmission),
      km_driven:           km,
      color:               safeString(form.color).trim(),
      owners:              safeInt(form.owners, 1),
      insurance_validity:  safeString(form.insurance_validity).trim(),
      rto_details:         safeString(form.rto_details).trim(),
      notes:               safeString(form.notes).trim(),
      starting_bid:        safeInt(form.starting_bid, 0),
      reserve_price:       safeInt(form.reserve_price, 0),
      duration_minutes:    safeInt(form.duration_minutes, 60),
      // No stock images — operator uploads real photos in the next step.
      // Backend creates this auction with status="draft" by default
      // (launch_immediately defaults to false).
      images: [] as string[],
      description: safeString(form.notes).trim() || `${form.registration_year} ${form.make} ${form.model} listed for wholesale auction.`,
    };
    console.log('[sell.launch] POST /api/cars →', { reg: payload.registration_number, km, reserve: payload.reserve_price });

    try {
      const res: any = await api.createCar(payload);
      const elapsed = Date.now() - t0;
      console.log('[sell.launch] draft created', { carId: res?.car?.id, auctionId: res?.auction?.id, status: res?.auction?.status, elapsed });

      if (!res?.car?.id || !res?.auction?.id) {
        // Backend success status but malformed body — surface this.
        throw new Error('Server returned an incomplete response (missing carId/auctionId)');
      }
      if (res.auction.status !== 'draft') {
        console.warn('[sell.launch] unexpected status', res.auction.status);
      }

      // Attach inspection PDF (if drafted in this session) to the new car
      if (pdfDraft && res?.car?.id) {
        try {
          await api.uploadInspection(res.car.id, pdfDraft.uri, pdfDraft.name);
          setPdfDraft(null);
          console.log('[sell.launch] inspection PDF attached');
        } catch (uploadErr: any) {
          console.error('[sell.launch] PDF upload failed', uploadErr);
          toast.show(`Draft saved, but PDF upload failed: ${uploadErr.message || 'retry from media manager'}`, 'error');
        }
      }

      toast.show('Draft created · upload photos next', 'success');

      // Hop directly to the media manager. We carry the auction_id so the
      // media screen can render its Launch button (which transitions the
      // draft → live once mandatory media gates are met).
      const nav = {
        pathname: '/inventory/[carId]/media' as const,
        params: { carId: res.car.id, auctionId: res.auction.id },
      };
      console.log('[sell.launch] navigating →', nav.pathname, nav.params);
      router.push(nav as any);

      // Clear form + draft for next listing
      setForm(EMPTY_FORM);
      setErrors({});
      setTouched(new Set());
      setAiEst(null);
      try { await storage.removeItem(DRAFT_KEY); } catch {}
      setDraftRestored(false);
    } catch (err: any) {
      const elapsed = Date.now() - t0;
      const detail = err?.message || String(err) || 'Unknown error';
      console.error('[sell.launch] FAILED', { detail, elapsed, payload });
      // Distinguish common server errors so the operator gets a clear next-step.
      let userMsg = detail;
      if (/401|Authentication|TOKEN_INVALID|TOKEN_EXPIRED/i.test(detail)) {
        userMsg = 'Session expired — please sign in again';
      } else if (/403|Admin access required|OPERATOR/i.test(detail)) {
        userMsg = 'Operator permission denied — your account may not have inventory rights';
      } else if (/network|fetch|timeout|abort/i.test(detail.toLowerCase())) {
        userMsg = 'Network error — check your connection and retry';
      } else if (/422|validation/i.test(detail)) {
        userMsg = `Server rejected the form: ${detail}`;
      }
      toast.show(userMsg, 'error');
    } finally {
      setCreating(false);
    }
  };

  // ---- Helpers for UI ----
  const errorFor = (k: keyof FormShape) => (touched.has(k) ? errors[k] : undefined);

  const savedLabel = useMemo(() => {
    if (!savedAt) return null;
    const secs = Math.max(1, Math.round((Date.now() - savedAt) / 1000));
    if (secs < 60) return `saved · ${secs}s ago`;
    return `saved · ${Math.round(secs / 60)}m ago`;
  }, [savedAt]);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={[styles.root, { paddingTop: insets.top + 10 }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.kickerRow}>
            <Text style={styles.kicker}>SELL ON Q DRIVES</Text>
            {savedLabel && (
              <View style={styles.draftPill}>
                <Save size={10} color={colors.textChrome} />
                <Text style={styles.draftText}>{savedLabel}</Text>
              </View>
            )}
          </View>
          <Text style={styles.title}>Launch an auction</Text>
          <Text style={styles.sub}>Verified inventory. Maximum bidder reach.</Text>
        </View>

        {/* Inspection card */}
        <TouchableOpacity
          activeOpacity={0.92}
          onPress={() => router.push('/sell/inspection')}
          testID="sell-inspection-cta"
          style={[
            styles.inspCard,
            inspStats.status === 'in_progress' && styles.inspCardProgress,
            inspStats.status === 'completed' && styles.inspCardDone,
          ]}
        >
          <View style={styles.inspTopRow}>
            <View style={[
              styles.inspBadge,
              inspStats.status === 'in_progress' && styles.inspBadgeProgress,
              inspStats.status === 'completed' && styles.inspBadgeDone,
            ]}>
              {inspStats.status === 'completed' ? (
                <ShieldCheck size={12} color={colors.success} />
              ) : (
                <FileCheck2 size={12} color={inspStats.status === 'in_progress' ? colors.warning : colors.red} />
              )}
              <Text style={[
                styles.inspBadgeText,
                inspStats.status === 'completed' && { color: colors.success },
                inspStats.status === 'in_progress' && { color: colors.warning },
                inspStats.status === 'not_started' && { color: colors.red },
              ]}>
                {inspStats.status === 'completed' ? 'COMPLETED' : inspStats.status === 'in_progress' ? 'IN PROGRESS' : 'NOT STARTED'}
              </Text>
            </View>
            <Text style={styles.inspPercent}>{inspStats.percent}%</Text>
          </View>
          <Text style={styles.inspTitle}>Complete inspection report</Text>
          <Text style={styles.inspSub}>
            {inspStats.status === 'completed'
              ? 'All sections verified · ready to launch'
              : inspStats.status === 'in_progress'
              ? `${inspStats.completed} of ${inspStats.total} sections complete · keep going`
              : 'Verified reports earn up to 18% higher bids on Q Drives'}
          </Text>
          <View style={styles.inspProgressTrack}>
            <View
              style={[
                styles.inspProgressFill,
                { width: `${inspStats.percent}%` },
                inspStats.status === 'completed' && { backgroundColor: colors.success },
                inspStats.status === 'in_progress' && { backgroundColor: colors.warning },
              ]}
            />
          </View>
          <View style={styles.inspCtaRow}>
            <Text style={styles.inspCtaText}>
              {inspStats.status === 'completed' ? 'Review inspection' : inspStats.status === 'in_progress' ? 'Continue inspection' : 'Start inspection'}
            </Text>
            <ChevronRight size={16} color={inspStats.status === 'completed' ? colors.success : inspStats.status === 'in_progress' ? colors.warning : colors.red} />
          </View>
        </TouchableOpacity>

        {/* Section: Vehicle details */}
        <View style={styles.sectionGroup}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Vehicle details</Text>
            <Text style={styles.sectionSub}>Enter the car information manually</Text>
          </View>

          {/* Demo RC autofill (clearly labeled, modular) */}
          <View style={styles.demoBlock}>
            <View style={styles.demoTopRow}>
              <View style={styles.demoIconWrap}>
                <FlaskConical size={13} color={colors.warning} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.demoLabel}>DEMO RC AUTOFILL</Text>
                <Text style={styles.demoHelp}>Loads sample data for testing. Not connected to VAHAN — real lookup will be added later.</Text>
              </View>
              <TouchableOpacity onPress={useDemoData} style={styles.demoBtn} testID="sell-demo-rc">
                <Text style={styles.demoBtnText}>Use demo</Text>
              </TouchableOpacity>
            </View>
          </View>

          {draftRestored && (
            <View style={styles.draftRestoreBar}>
              <Save size={14} color={colors.success} />
              <Text style={styles.draftRestoreText}>Draft restored from your last session</Text>
              <TouchableOpacity onPress={clearForm} style={styles.draftRestoreBtn}>
                <Trash2 size={12} color={colors.red} />
                <Text style={styles.draftRestoreBtnText}>Clear</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Registration */}
          <Field label="Registration Number" required error={errorFor('registration_number')}>
            <TextInput
              placeholder="e.g. MH02AB1234"
              placeholderTextColor={colors.textMuted}
              value={form.registration_number}
              onChangeText={(v) => u('registration_number', v.toUpperCase().replace(/\s+/g, ''))}
              onBlur={() => markTouched('registration_number')}
              autoCapitalize="characters"
              maxLength={12}
              style={styles.input}
              testID="sell-reg-input"
            />
          </Field>

          {/* Make / Model row */}
          <View style={styles.row2}>
            <View style={{ flex: 1 }}>
              <Field label="Make" required error={errorFor('make')}>
                <TextInput
                  placeholder="e.g. Hyundai"
                  placeholderTextColor={colors.textMuted}
                  value={form.make}
                  onChangeText={(v) => u('make', v)}
                  onBlur={() => markTouched('make')}
                  style={styles.input}
                  testID="sell-make"
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Model" required error={errorFor('model')}>
                <TextInput
                  placeholder="e.g. Tucson"
                  placeholderTextColor={colors.textMuted}
                  value={form.model}
                  onChangeText={(v) => u('model', v)}
                  onBlur={() => markTouched('model')}
                  style={styles.input}
                  testID="sell-model"
                />
              </Field>
            </View>
          </View>

          {/* Variant */}
          <Field label="Variant" hint="Optional">
            <TextInput
              placeholder="e.g. Signature 1.4 Turbo"
              placeholderTextColor={colors.textMuted}
              value={form.variant}
              onChangeText={(v) => u('variant', v)}
              style={styles.input}
              testID="sell-variant"
            />
          </Field>

          {/* Manufacturing Year / Registration Year */}
          <View style={styles.row2}>
            <View style={{ flex: 1 }}>
              <Field label="Manufacturing Year" required error={errorFor('manufacturing_year')}>
                <Select
                  value={form.manufacturing_year ?? undefined}
                  onChange={(v) => { u('manufacturing_year', v); markTouched('manufacturing_year'); }}
                  options={YEAR_OPTIONS}
                  placeholder="Select year"
                  modalTitle="Manufacturing year"
                  testID="sell-mfg-year"
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Registration Year" required error={errorFor('registration_year')}>
                <Select
                  value={form.registration_year ?? undefined}
                  onChange={(v) => { u('registration_year', v); markTouched('registration_year'); }}
                  options={YEAR_OPTIONS}
                  placeholder="Select year"
                  modalTitle="Registration year"
                  testID="sell-reg-year"
                />
              </Field>
            </View>
          </View>

          {/* KM driven */}
          <Field label="Kilometers Driven" required error={errorFor('km_driven')}>
            <TextInput
              placeholder="e.g. 32500"
              placeholderTextColor={colors.textMuted}
              value={form.km_driven}
              onChangeText={(v) => u('km_driven', v.replace(/[^0-9]/g, ''))}
              onBlur={() => markTouched('km_driven')}
              keyboardType="number-pad"
              maxLength={7}
              style={styles.input}
              testID="sell-km"
            />
          </Field>

          {/* Fuel & Transmission */}
          <View style={styles.row2}>
            <View style={{ flex: 1 }}>
              <Field label="Fuel Type" required error={errorFor('fuel_type')}>
                <Select
                  value={form.fuel_type || undefined}
                  onChange={(v) => { u('fuel_type', v); markTouched('fuel_type'); }}
                  options={FUEL}
                  placeholder="Select fuel"
                  modalTitle="Fuel type"
                  testID="sell-fuel"
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Transmission" required error={errorFor('transmission')}>
                <Select
                  value={form.transmission || undefined}
                  onChange={(v) => { u('transmission', v); markTouched('transmission'); }}
                  options={TRANS}
                  placeholder="Select"
                  modalTitle="Transmission"
                  testID="sell-trans"
                />
              </Field>
            </View>
          </View>

          {/* Owners + Color */}
          <View style={styles.row2}>
            <View style={{ flex: 1 }}>
              <Field label="Ownership" required>
                <Select
                  value={form.owners}
                  onChange={(v) => u('owners', v as number)}
                  options={OWNER_OPTIONS}
                  modalTitle="Ownership history"
                  testID="sell-owners"
                />
              </Field>
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Color" hint="Optional">
                <TextInput
                  placeholder="e.g. Phantom Black"
                  placeholderTextColor={colors.textMuted}
                  value={form.color}
                  onChangeText={(v) => u('color', v)}
                  style={styles.input}
                  testID="sell-color"
                />
              </Field>
            </View>
          </View>

          {/* Insurance */}
          <Field label="Insurance Validity" hint="Optional · MM/YYYY" error={errorFor('insurance_validity')}>
            <TextInput
              placeholder="e.g. 08/2026"
              placeholderTextColor={colors.textMuted}
              value={form.insurance_validity}
              onChangeText={(v) => {
                // auto-insert slash after MM
                let s = v.replace(/[^0-9]/g, '').slice(0, 6);
                if (s.length > 2) s = `${s.slice(0, 2)}/${s.slice(2)}`;
                u('insurance_validity', s);
              }}
              onBlur={() => markTouched('insurance_validity')}
              keyboardType="number-pad"
              maxLength={7}
              style={styles.input}
              testID="sell-insurance"
            />
          </Field>

          {/* RTO */}
          <Field label="RTO Details" hint="Optional">
            <TextInput
              placeholder="e.g. MH02 - Mumbai West"
              placeholderTextColor={colors.textMuted}
              value={form.rto_details}
              onChangeText={(v) => u('rto_details', v)}
              style={styles.input}
              testID="sell-rto"
            />
          </Field>

          {/* Notes */}
          <Field label="Notes / Additional Remarks" hint="Optional · seen by bidders">
            <TextInput
              placeholder="e.g. Single owner, full service history at authorised dealer, no accidents."
              placeholderTextColor={colors.textMuted}
              value={form.notes}
              onChangeText={(v) => u('notes', v)}
              style={[styles.input, styles.textarea]}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              maxLength={500}
              testID="sell-notes"
            />
          </Field>
        </View>

        {/* Wholesale Valuation Engine — deterministic price band */}
        <View style={styles.sectionGroup}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Wholesale Valuation Engine</Text>
            <Text style={styles.sectionSub}>Deterministic price band from above details</Text>
          </View>
          <View style={styles.aiCard}>
            <View style={styles.aiHead}>
              <Sparkles size={18} color={colors.red} />
              <Text style={styles.aiTitle}>Instant valuation</Text>
            </View>
            {aiEst ? (
              <>
                <Text style={styles.aiPrice}>{formatINRFull(aiEst.estimated_price_inr)}</Text>
                <Text style={styles.aiRange}>
                  Range {formatINR(aiEst.market_low_inr)} – {formatINR(aiEst.market_high_inr)} · {aiEst.confidence} confidence
                </Text>
                <Text style={styles.aiReason}>{aiEst.reasoning}</Text>
                <TouchableOpacity onPress={estimate} disabled={estimating} style={[styles.aiBtn, { marginTop: 12 }]}>
                  {estimating ? <ActivityIndicator color={colors.red} /> : <Text style={styles.aiBtnText}>Re-run valuation</Text>}
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity onPress={estimate} disabled={estimating || !canEstimate} style={[styles.aiBtn, !canEstimate && { opacity: 0.5 }]} testID="sell-ai-estimate-btn">
                {estimating ? <ActivityIndicator color={colors.red} /> : <Text style={styles.aiBtnText}>Run wholesale valuation</Text>}
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Pricing */}
        <View style={styles.sectionGroup}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Auction pricing</Text>
            <Text style={styles.sectionSub}>Set reserve & opening bid</Text>
          </View>

          <Field label="Starting bid" required error={errorFor('starting_bid')}>
            <TextInput
              placeholder="e.g. 1500000"
              placeholderTextColor={colors.textMuted}
              value={form.starting_bid ? String(form.starting_bid) : ''}
              onChangeText={(v) => u('starting_bid', parseInt(v.replace(/[^0-9]/g, ''), 10) || 0)}
              onBlur={() => markTouched('starting_bid')}
              keyboardType="number-pad"
              style={styles.input}
              testID="sell-start-bid"
            />
            {!!form.starting_bid && <Text style={styles.inlineHint}>{formatINRFull(form.starting_bid)}</Text>}
          </Field>

          <Field label="Reserve price" required error={errorFor('reserve_price')}>
            <TextInput
              placeholder="e.g. 1700000"
              placeholderTextColor={colors.textMuted}
              value={form.reserve_price ? String(form.reserve_price) : ''}
              onChangeText={(v) => u('reserve_price', parseInt(v.replace(/[^0-9]/g, ''), 10) || 0)}
              onBlur={() => markTouched('reserve_price')}
              keyboardType="number-pad"
              style={styles.input}
              testID="sell-reserve-bid"
            />
            {!!form.reserve_price && <Text style={styles.inlineHint}>{formatINRFull(form.reserve_price)}</Text>}
          </Field>

          <View style={styles.priceQuickRow}>
            {[-100000, -50000, 50000, 100000].map((d) => (
              <TouchableOpacity
                key={d}
                onPress={() => u('reserve_price', Math.max(50000, (form.reserve_price || 0) + d))}
                style={styles.priceChip}
                disabled={!form.reserve_price}
              >
                <Text style={styles.priceChipText}>{d > 0 ? '+' : ''}{formatINR(d)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Duration */}
        <View style={styles.sectionGroup}>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>Auction duration</Text>
          </View>
          <View style={styles.durRow}>
            {/* Duration pills — 30/60/120/240 minutes + 7-day marathon
             *   listing for long-form vehicle distribution (e.g. fleet
             *   liquidation). Backend caps at 14 days via Pydantic
             *   Field(le=14*24*60); 7d gives clear headroom. */}
            {[
              { value: 30,    label: '30 min'  },
              { value: 60,    label: '60 min'  },
              { value: 120,   label: '2 hours' },
              { value: 240,   label: '4 hours' },
              { value: 10080, label: '7 days'  },
            ].map(({ value: d, label }) => (
              <TouchableOpacity
                key={d}
                onPress={() => u('duration_minutes', d)}
                style={[styles.durPill, form.duration_minutes === d && styles.durPillActive]}
                testID={`sell-duration-${d}`}
              >
                <Clock size={12} color={form.duration_minutes === d ? colors.red : colors.textChrome} />
                <Text style={[styles.durText, form.duration_minutes === d && { color: colors.red }]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Launch */}
        <TouchableOpacity
          onPress={launch}
          disabled={creating}
          style={[
            styles.launch,
            inspStats.status !== 'completed' && styles.launchLocked,
          ]}
          testID="sell-launch-btn"
        >
          {inspStats.status !== 'completed' ? (
            <FileCheck2 size={16} color="#fff" />
          ) : (
            <ImagePlus size={18} color="#fff" />
          )}
          <Text style={styles.launchText}>
            {creating
              ? 'Creating draft...'
              : inspStats.status !== 'completed'
              ? `Inspection ${inspStats.percent}% — Launch locked`
              : 'Save draft & upload photos'}
          </Text>
          {inspStats.status === 'completed' && !creating && <ArrowRight size={18} color="#fff" />}
        </TouchableOpacity>

        <Text style={styles.legalNote}>
          We save this as a <Text style={{ color: colors.textChrome, fontWeight: '800' }}>Draft</Text> first.
          Upload exterior/interior/damage photos in the next screen, then tap{' '}
          <Text style={{ color: colors.red, fontWeight: '800' }}>Launch Auction</Text> to publish it to verified dealers.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---- Field component ----
function Field({
  label, required, hint, error, children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={fieldStyles.wrap}>
      <View style={fieldStyles.labelRow}>
        <Text style={fieldStyles.label}>
          {label}
          {required ? <Text style={fieldStyles.requiredStar}> *</Text> : null}
        </Text>
        {hint && !error && <Text style={fieldStyles.hint}>{hint}</Text>}
      </View>
      {children}
      {!!error && (
        <View style={fieldStyles.errorRow}>
          <AlertCircle size={11} color={colors.red} />
          <Text style={fieldStyles.errorText}>{error}</Text>
        </View>
      )}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  wrap: { marginBottom: 14 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 6 },
  label: { color: colors.textChrome, fontSize: 12, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  requiredStar: { color: colors.red, fontWeight: '900' },
  hint: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  errorText: { color: colors.red, fontSize: 11, fontWeight: '700' },
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 20, marginBottom: 18 },
  kickerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kicker: { color: colors.red, fontSize: 11, fontWeight: '800', letterSpacing: 1.6 },
  draftPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  draftText: { color: colors.textChrome, fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '800', marginTop: 6, letterSpacing: -0.5 },
  sub: { color: colors.textSecondary, fontSize: 14, marginTop: 4, lineHeight: 20 },

  sectionGroup: { paddingHorizontal: 20, marginBottom: 22 },
  sectionHead: { marginBottom: 12 },
  sectionTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  sectionSub: { color: colors.textMuted, fontSize: 12, fontWeight: '500', marginTop: 2 },

  // demo block
  demoBlock: {
    backgroundColor: 'rgba(245,158,11,0.05)',
    borderColor: 'rgba(245,158,11,0.4)', borderWidth: 1, borderStyle: 'dashed',
    borderRadius: radii.md, padding: 12, marginBottom: 16,
  },
  demoTopRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  demoIconWrap: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)' },
  demoLabel: { color: colors.warning, fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
  demoHelp: { color: colors.textChrome, fontSize: 11, marginTop: 2, lineHeight: 15, fontWeight: '500' },
  demoBtn: { backgroundColor: colors.warning, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radii.sm },
  demoBtnText: { color: '#0B0B0D', fontSize: 11, fontWeight: '900', letterSpacing: 0.4 },

  // draft restored bar
  draftRestoreBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(16,185,129,0.05)', borderColor: 'rgba(16,185,129,0.3)', borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: radii.sm, marginBottom: 14,
  },
  draftRestoreText: { color: colors.textChrome, fontSize: 11, fontWeight: '600', flex: 1 },
  draftRestoreBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, backgroundColor: 'rgba(185,28,28,0.08)', borderRadius: 999, borderWidth: 1, borderColor: 'rgba(185,28,28,0.3)' },
  draftRestoreBtnText: { color: colors.red, fontSize: 11, fontWeight: '800' },

  // inputs
  input: {
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 14,
    color: colors.textPrimary, fontSize: 15, fontWeight: '600',
  },
  textarea: { minHeight: 92, paddingTop: 12, paddingBottom: 12 },
  inlineHint: { color: colors.textMuted, fontSize: 11, fontWeight: '600', marginTop: 5, marginLeft: 2 },

  row2: { flexDirection: 'row', gap: 10 },

  // AI
  aiCard: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.lg, padding: 16 },
  aiHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  aiTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  aiPrice: { color: colors.textPrimary, fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  aiRange: { color: colors.textChrome, fontSize: 12, marginTop: 4 },
  aiReason: { color: colors.textSecondary, fontSize: 12, marginTop: 8, lineHeight: 18 },
  aiBtn: { backgroundColor: 'rgba(185,28,28,0.16)', borderColor: colors.red, borderWidth: 1, paddingVertical: 12, borderRadius: radii.md, alignItems: 'center' },
  aiBtnText: { color: colors.red, fontWeight: '800', fontSize: 13 },

  // pricing
  priceQuickRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  priceChip: { flex: 1, paddingVertical: 8, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: 999, alignItems: 'center' },
  priceChipText: { color: colors.textChrome, fontSize: 11, fontWeight: '700' },

  // duration
  durRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  durPill: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1 },
  durPillActive: { backgroundColor: 'rgba(185,28,28,0.12)', borderColor: colors.red },
  durText: { color: colors.textChrome, fontSize: 12, fontWeight: '700' },

  // launch
  launch: {
    marginHorizontal: 20, marginTop: 8,
    backgroundColor: colors.red, paddingVertical: 16, borderRadius: radii.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8,
  },
  launchLocked: { backgroundColor: '#3F2828', shadowOpacity: 0 },
  launchText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  legalNote: { color: colors.textMuted, fontSize: 11, lineHeight: 16, paddingHorizontal: 24, marginTop: 14, textAlign: 'center' },

  // Inspection card
  inspCard: {
    marginHorizontal: 20, marginBottom: 22, padding: 18,
    backgroundColor: 'rgba(185,28,28,0.06)',
    borderColor: colors.red, borderWidth: 1.5, borderRadius: radii.lg,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 16, elevation: 6,
  },
  inspCardProgress: { backgroundColor: 'rgba(245,158,11,0.06)', borderColor: 'rgba(245,158,11,0.6)', shadowColor: colors.warning },
  inspCardDone: { backgroundColor: 'rgba(16,185,129,0.06)', borderColor: 'rgba(16,185,129,0.55)', shadowColor: colors.success },
  inspTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  inspBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: 'rgba(185,28,28,0.16)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)' },
  inspBadgeProgress: { backgroundColor: 'rgba(245,158,11,0.16)', borderColor: 'rgba(245,158,11,0.5)' },
  inspBadgeDone: { backgroundColor: 'rgba(16,185,129,0.16)', borderColor: 'rgba(16,185,129,0.5)' },
  inspBadgeText: { fontSize: 9, fontWeight: '900', letterSpacing: 1.4 },
  inspPercent: { color: colors.textPrimary, fontSize: 22, fontWeight: '900', letterSpacing: -0.6 },
  inspTitle: { color: colors.textPrimary, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  inspSub: { color: colors.textChrome, fontSize: 12, marginTop: 4, fontWeight: '500', lineHeight: 17 },
  inspProgressTrack: { height: 6, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden', marginTop: 14 },
  inspProgressFill: { height: '100%', backgroundColor: colors.red, borderRadius: 3 },
  inspCtaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  inspCtaText: { color: colors.textPrimary, fontSize: 13, fontWeight: '800', letterSpacing: 0.4 },
});
