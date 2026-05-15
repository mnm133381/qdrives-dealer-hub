/**
 * Media client: compression + upload helpers for Q Drives.
 *
 * Storage-agnostic from the frontend's POV — the only thing we know about
 * the backend is the `POST /api/media/upload` endpoint shape. Easy to swap
 * to S3 presigned URLs later without touching this UI code.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import { storage } from './storage';
import { TOKEN_KEY } from './api';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

export const SECTIONS = ['exterior', 'interior', 'engine', 'tyres', 'damage', 'documents', 'inspection'] as const;
export type SectionKey = (typeof SECTIONS)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  exterior: 'Exterior',
  interior: 'Interior',
  engine: 'Engine Bay',
  tyres: 'Tyres & Wheels',
  damage: 'Damage',
  documents: 'Documents',
  inspection: 'Inspection',
};

export const SECTION_HINTS: Record<SectionKey, string> = {
  exterior: 'front, rear, both sides, all 4 corners',
  interior: 'driver, passenger, rear seats, dash, infotainment, odometer',
  engine: 'full engine bay + closeups',
  tyres: 'all four wheels & tyre tread',
  damage: 'dents, scratches, repaint, cracks',
  documents: 'RC front + RC back, insurance',
  inspection: 'underbody, chassis, VIN plate',
};

export const MANDATORY_MIN: Record<SectionKey, number> = {
  exterior: 8,
  interior: 6,
  engine: 3,
  tyres: 4,
  damage: 0,         // damage is special — handled via attestation
  documents: 2,
  inspection: 1,
};

export const MAX_PER_CAR = 50;

// ---- Adaptive compression ----
/**
 * Compress an image source URI so it stays under ~600KB while keeping enough
 * resolution for zoomed inspection of dents/scratches/VIN/odometer.
 *
 *   Pass 1 — resize to maxWidth=1920, JPEG q=0.82
 *   Pass 2 — if result still > 700KB (huge phone cameras), repack q=0.72
 *   Pass 3 — last resort, downscale to 1600px, q=0.72
 *
 * Also generates a square-ish 480px thumbnail at q=0.65 for the gallery grid.
 *
 * Returns absolute URIs ready for upload.
 */
export async function compressForUpload(srcUri: string): Promise<{
  fullUri: string;
  thumbUri: string;
  fullSize: number;
  thumbSize: number;
  width: number;
  height: number;
}> {
  // Pass 1
  let full = await ImageManipulator.manipulateAsync(
    srcUri,
    [{ resize: { width: 1920 } }],
    { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG },
  );
  let fullSize = await getSize(full.uri);
  if (fullSize > 700 * 1024) {
    // Pass 2 — same dims, lower quality
    const r2 = await ImageManipulator.manipulateAsync(
      full.uri,
      [],
      { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG },
    );
    full = r2;
    fullSize = await getSize(full.uri);
  }
  if (fullSize > 900 * 1024) {
    // Pass 3 — downscale further
    const r3 = await ImageManipulator.manipulateAsync(
      srcUri,
      [{ resize: { width: 1600 } }],
      { compress: 0.72, format: ImageManipulator.SaveFormat.JPEG },
    );
    full = r3;
    fullSize = await getSize(full.uri);
  }

  // Thumbnail (gallery grid)
  const thumb = await ImageManipulator.manipulateAsync(
    full.uri,
    [{ resize: { width: 480 } }],
    { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG },
  );
  const thumbSize = await getSize(thumb.uri);

  return {
    fullUri: full.uri,
    thumbUri: thumb.uri,
    fullSize,
    thumbSize,
    width: full.width || 1920,
    height: full.height || 1080,
  };
}

async function getSize(uri: string): Promise<number> {
  // Fetch HEAD on the local file — works on Android/iOS via expo file:// scheme,
  // and on web via blob: URLs. If unknown, return 0 (still uploads fine).
  try {
    const r = await fetch(uri);
    const blob = await r.blob();
    return blob.size || 0;
  } catch {
    return 0;
  }
}

// ---- Upload (multipart) ----
export type UploadProgress = {
  loaded: number;
  total: number;
  pct: number;
};

/**
 * Uploads a single (full + thumb) media pair using XHR so we can stream
 * progress events. Auto-retries up to `retries` times with 1s backoff on
 * network errors.
 */
export function uploadMediaXhr(opts: {
  carId: string;
  section: SectionKey;
  subsection?: string;
  fullUri: string;
  thumbUri?: string;
  width?: number;
  height?: number;
  filename?: string;
  onProgress?: (p: UploadProgress) => void;
  retries?: number;
}): Promise<any> {
  const retries = opts.retries ?? 2;
  return uploadOnce(opts).catch(async (err) => {
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 1000));
    return uploadMediaXhr({ ...opts, retries: retries - 1 });
  });
}

/**
 * Normalise any FastAPI / fetch error payload to a single human-readable
 * string. FastAPI 422 returns `detail` as an ARRAY of pydantic error
 * objects like `[{type, loc, msg, ...}]`, and naïvely doing
 * `new Error(data.detail)` produces the infamous
 * "[object Object],[object Object]" toast that hid the real cause for
 * us in production.
 *
 * Order of precedence:
 *   1. Array of {msg|loc} objects   → join "field: msg, field: msg"
 *   2. Single object with msg/detail → use that
 *   3. Plain string                  → use as-is
 *   4. anything else                  → JSON.stringify (last resort)
 */
function formatErrorDetail(data: any, status?: number): string {
  if (!data) return status ? `Upload failed (${status})` : 'Upload failed';
  const detail = data.detail ?? data.message ?? data;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d: any) => {
      if (!d) return '';
      if (typeof d === 'string') return d;
      const loc = Array.isArray(d.loc) ? d.loc.filter((x: any) => x !== 'body').join('.') : '';
      const msg = d.msg || d.message || d.type || JSON.stringify(d);
      return loc ? `${loc}: ${msg}` : msg;
    }).filter(Boolean);
    return parts.length ? parts.join(', ') : `Upload failed (${status ?? '?'})`;
  }
  if (typeof detail === 'object') {
    return detail.msg || detail.message || JSON.stringify(detail);
  }
  return String(detail);
}

/**
 * Build the file part of the multipart form. React Native and web
 * disagree about how to attach a local image:
 *
 *   • iOS / Android (React Native FormData polyfill):
 *       fd.append('file', { uri, type, name })  ← required shape
 *
 *   • Web (browser native FormData):
 *       fd.append('file', BlobOrFile, filename) ← `{uri,...}` is
 *       silently coerced to "[object Object]" which then FAILS
 *       FastAPI's `UploadFile = File(...)` validator and returns a 422
 *       with `detail = [{type:"missing", loc:["body","file"]}, ...]`
 *       — the exact crash that produced the "[object Object],[object
 *       Object]" toast on emergent.host.
 *
 * For web we fetch the (blob:/data:/http:) URI as a Blob and append
 * that instead. For native we keep the legacy shape.
 */
async function buildFilePart(uri: string, name: string): Promise<any> {
  if (typeof window !== 'undefined' && typeof (window as any).Blob !== 'undefined' && uri && (uri.startsWith('blob:') || uri.startsWith('data:') || uri.startsWith('http'))) {
    // Web path — must be a real Blob to satisfy `UploadFile`.
    const r = await fetch(uri);
    const blob = await r.blob();
    // Pass the filename as the 3rd FormData arg.
    return { __webBlob: blob, __webName: name };
  }
  // React Native path — keep legacy shape.
  return { uri, type: 'image/jpeg', name };
}

async function uploadOnce(opts: any): Promise<any> {
  const token = await storage.getItem(TOKEN_KEY);
  // Pre-build the file parts (may need an async Blob fetch on web).
  const filePart = await buildFilePart(opts.fullUri, opts.filename || 'photo.jpg');
  const thumbPart = opts.thumbUri ? await buildFilePart(opts.thumbUri, 'thumb.jpg') : null;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${BASE}/api/media/upload`;
    xhr.open('POST', url);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (ev) => {
      if (opts.onProgress && ev.total) {
        opts.onProgress({ loaded: ev.loaded, total: ev.total, pct: ev.loaded / ev.total });
      }
    };
    xhr.onload = () => {
      try {
        const data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          // CRITICAL: format errors that come back as arrays of pydantic
          // objects so the toast never shows "[object Object],..." again.
          const err = new Error(formatErrorDetail(data, xhr.status));
          (err as any).status = xhr.status;
          (err as any).detail = data;
          reject(err);
        }
      } catch (e: any) {
        reject(new Error(e?.message || `Upload parse failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error — check your connection'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));

    const fd = new FormData();
    fd.append('car_id', opts.carId);
    fd.append('section', opts.section);
    if (opts.subsection) fd.append('subsection', opts.subsection);
    if (opts.width)  fd.append('width', String(opts.width));
    if (opts.height) fd.append('height', String(opts.height));
    if (filePart.__webBlob) {
      fd.append('file', filePart.__webBlob, filePart.__webName);
    } else {
      fd.append('file', filePart as any);
    }
    if (thumbPart) {
      if (thumbPart.__webBlob) {
        fd.append('thumb', thumbPart.__webBlob, thumbPart.__webName);
      } else {
        fd.append('thumb', thumbPart as any);
      }
    }
    xhr.send(fd as any);
  });
}

/** Resolve relative `/api/media/...` URLs to absolute. */
export function absUrl(u: string): string {
  if (!u) return u;
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  return `${BASE}${u}`;
}
