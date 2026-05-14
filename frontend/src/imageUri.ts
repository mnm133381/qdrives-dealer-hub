/**
 * Shared image-URL resolver.
 *
 * The backend now returns BOTH absolute legacy URLs (e.g. Unsplash demo)
 * AND relative API paths (e.g. "/api/media/<id>/file" for operator-
 * uploaded gridfs media). Native React Native cannot fetch a relative
 * path — we must prefix it with EXPO_PUBLIC_BACKEND_URL so the APK
 * targets the production backend.
 *
 * Rules:
 *   - "" / null / undefined → returns "" (let caller decide on placeholder)
 *   - starts with "http"   → returned as-is (already absolute)
 *   - any other            → prefixed with BACKEND_URL
 *
 * The same helper is used by every car-image render site so we have a
 * single source of truth for image URL resolution.
 */
const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

export function resolveImageUri(raw?: string | null): string {
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) {
    return raw;
  }
  return `${BACKEND_URL}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

/**
 * Convenience for car.images[] arrays — returns the first non-empty
 * resolved URL, or '' if none. Used by list/grid card components.
 */
export function firstCarImage(images?: string[] | null): string {
  if (!Array.isArray(images)) return '';
  for (const img of images) {
    if (img) return resolveImageUri(img);
  }
  return '';
}
