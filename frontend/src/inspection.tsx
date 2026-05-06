/**
 * Q Drives — Inspection draft state.
 *
 * Stores an in-progress inspection report locally so dealers can fill it in
 * sections, navigate away, and return without losing data. Persisted via the
 * safe storage wrapper (in-memory fallback if storage unavailable).
 */
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { storage } from './storage';

const KEY = 'qdrives_inspection_draft';

export type SectionKey = 'exterior' | 'interior' | 'mechanical' | 'tyres' | 'documents' | 'photos';

export type SectionState = {
  completed: boolean;
  score?: number;        // 1-10 dealer self-assessment
  notes?: string;
  // documents fields
  rc?: boolean;
  insurance?: boolean;
  puc?: boolean;
  // photos field
  photoCount?: number;
};

export type InspectionDraft = Record<SectionKey, SectionState>;

export const SECTIONS: { key: SectionKey; label: string; description: string }[] = [
  { key: 'exterior',   label: 'Exterior',          description: 'Paint, body panels, dents and scratches' },
  { key: 'interior',   label: 'Interior',          description: 'Seats, dashboard, AC, infotainment' },
  { key: 'mechanical', label: 'Engine & Mechanical', description: 'Engine, transmission, suspension' },
  { key: 'tyres',      label: 'Tyres & Wheels',    description: 'Tread depth, alignment, alloy condition' },
  { key: 'documents',  label: 'Documents',         description: 'RC, insurance, PUC certificate' },
  { key: 'photos',     label: 'Photos',            description: 'Front, back, sides, interior shots' },
];

const EMPTY: InspectionDraft = {
  exterior:   { completed: false },
  interior:   { completed: false },
  mechanical: { completed: false },
  tyres:      { completed: false },
  documents:  { completed: false, rc: false, insurance: false, puc: false },
  photos:     { completed: false, photoCount: 0 },
};

export type PdfDraft = {
  uri: string;
  name: string;
  size?: number;
} | null;

const PDF_KEY = 'qdrives_inspection_pdf_draft';

type Ctx = {
  draft: InspectionDraft;
  pdfDraft: PdfDraft;
  loading: boolean;
  updateSection: (key: SectionKey, patch: Partial<SectionState>) => void;
  completeSection: (key: SectionKey) => void;
  setPdfDraft: (pdf: PdfDraft) => void;
  reset: () => void;
};

const InspectionContext = createContext<Ctx>({
  draft: EMPTY,
  pdfDraft: null,
  loading: true,
  updateSection: () => {},
  completeSection: () => {},
  setPdfDraft: () => {},
  reset: () => {},
});

export function InspectionProvider({ children }: { children: React.ReactNode }) {
  const [draft, setDraft] = useState<InspectionDraft>(EMPTY);
  const [pdfDraft, setPdfDraftState] = useState<PdfDraft>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const raw = await storage.getItem(KEY);
      if (raw) {
        try { setDraft({ ...EMPTY, ...JSON.parse(raw) }); } catch {}
      }
      const rawPdf = await storage.getItem(PDF_KEY);
      if (rawPdf) {
        try { setPdfDraftState(JSON.parse(rawPdf)); } catch {}
      }
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (next: InspectionDraft) => {
    setDraft(next);
    await storage.setItem(KEY, JSON.stringify(next));
  }, []);

  const updateSection = useCallback((key: SectionKey, patch: Partial<SectionState>) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      storage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const completeSection = useCallback((key: SectionKey) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: { ...prev[key], completed: true } };
      storage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const setPdfDraft = useCallback((pdf: PdfDraft) => {
    setPdfDraftState(pdf);
    if (pdf) storage.setItem(PDF_KEY, JSON.stringify(pdf)).catch(() => {});
    else storage.removeItem(PDF_KEY).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    persist(EMPTY);
    setPdfDraft(null);
  }, [persist, setPdfDraft]);

  return (
    <InspectionContext.Provider value={{ draft, pdfDraft, loading, updateSection, completeSection, setPdfDraft, reset }}>
      {children}
    </InspectionContext.Provider>
  );
}

export const useInspection = () => useContext(InspectionContext);

export function inspectionStats(draft: InspectionDraft) {
  const total = SECTIONS.length;
  const completed = SECTIONS.filter((s) => draft[s.key]?.completed).length;
  const percent = Math.round((completed / total) * 100);
  let status: 'not_started' | 'in_progress' | 'completed';
  if (completed === 0) status = 'not_started';
  else if (completed >= total) status = 'completed';
  else status = 'in_progress';
  return { total, completed, percent, status };
}
