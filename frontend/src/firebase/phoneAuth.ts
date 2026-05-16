/**
 * Cross-platform phone-auth API surface. Metro picks the platform
 * sibling automatically:
 *   - phoneAuth.native.ts  →  iOS / Android (uses @react-native-firebase/auth)
 *   - phoneAuth.web.ts     →  Web preview     (uses firebase JS SDK + reCAPTCHA)
 *
 * This file exists purely so TypeScript can resolve the API shape
 * regardless of platform during type-checking. The actual types and
 * `PhoneAuthError` class live in `./phoneAuth.shared` to avoid a
 * platform-vs-base import cycle (Metro resolves `./phoneAuth` to the
 * platform variant first, so re-exporting from that path was recursive
 * and blew up the bundle).
 */
export { PhoneAuthError } from './phoneAuth.shared';
export type { PhoneOtpHandle, PhoneAuthApi } from './phoneAuth.shared';
import { PhoneAuthApi, PhoneAuthError } from './phoneAuth.shared';

// Default export gets shadowed by the platform-specific files via
// Metro's `.native.ts` / `.web.ts` resolution. This stub only runs
// on platforms we don't explicitly target (currently none).
const stub: PhoneAuthApi = {
  isAvailable: () => false,
  async sendOtp() {
    throw new PhoneAuthError('unsupported', 'Phone auth is not supported on this platform.');
  },
  async confirmOtp() {
    throw new PhoneAuthError('unsupported', 'Phone auth is not supported on this platform.');
  },
  async signOut() { /* no-op */ },
};

export default stub;
