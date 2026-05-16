/**
 * Platform-agnostic types and error class shared by phoneAuth.{ts,web,native}.
 *
 * Why a separate file?  Both `phoneAuth.web.ts` and `phoneAuth.native.ts`
 * need to re-export `PhoneAuthError` so that `import { PhoneAuthError }
 * from './phoneAuth'` resolves on every platform.  Re-exporting it from
 * the base `./phoneAuth` causes a self-recursive import on platforms
 * where `./phoneAuth` resolves back to `phoneAuth.{web,native}.ts`
 * (Metro picks the platform variant first).  That recursion blew up
 * the bundle with "Maximum call stack size exceeded".
 *
 * Putting the symbols here — in a file with NO platform variant —
 * breaks the cycle.
 */
export interface PhoneOtpHandle {
  readonly _kind: 'native' | 'web';
}

export interface PhoneAuthApi {
  sendOtp(phoneE164: string): Promise<PhoneOtpHandle>;
  confirmOtp(handle: PhoneOtpHandle, code: string): Promise<string>;
  isAvailable(): boolean;
  signOut(): Promise<void>;
}

export class PhoneAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
