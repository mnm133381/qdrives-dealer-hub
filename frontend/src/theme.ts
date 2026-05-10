// Q Drives — Design tokens
// Premium automotive dealer-auction infrastructure palette.
// Deep navy-tinted blacks for surface depth (avoids pure flat black),
// gunmetal panels, controlled red, no gaming/esports look.
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const colors = {
  // Base surfaces — three depths to create embedded card feel,
  // each with a faint navy tint for premium depth.
  bg: '#050505',           // canvas (matte black)
  bgDeep: '#070B14',       // mid-depth (subtle navy)
  bgCard: '#0B1020',       // card surface (darkest navy)
  bgElevated: '#0F1424',   // raised modals / sheets
  bgOverlay: 'rgba(5, 5, 5, 0.88)',

  // Type ladder
  textPrimary: '#F5F7FA',  // metric / heading
  textChrome: '#D6DAE2',   // body
  textSecondary: '#9099A6',
  textMuted: '#6B7280',

  // Accent system
  red: '#FF1E2D',          // sharper hot red — auction energy
  redHover: '#D4141E',
  redPulse: 'rgba(255, 30, 45, 0.22)',
  redGlow: 'rgba(255, 30, 45, 0.30)',
  redAmbient: 'rgba(255, 30, 45, 0.10)',  // soft top-edge highlights
  silver: '#B7BDC9',

  border: '#1A1F2D',       // navy-tinted border (was flat #20232B)
  borderSoft: '#10141F',   // ultra-subtle separators
  borderFocus: '#3A3F4A',

  success: '#00D084',
  successBg: 'rgba(0, 208, 132, 0.10)',
  successGlow: 'rgba(0, 208, 132, 0.22)',
  warning: '#F59E0B',
  warningBg: 'rgba(245, 158, 11, 0.10)',
  danger: '#EF4444',
  info: '#3B82F6',
};

export const radii = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  pill: 999,
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 36,
};

export const fonts = {
  heading: 'Outfit_700Bold',
  headingSemi: 'Outfit_600SemiBold',
  body: 'Manrope_500Medium',
  bodyBold: 'Manrope_700Bold',
  mono: 'JetBrainsMono_700Bold',
};

export const shadows = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 4,
  },
  cardElevated: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
    elevation: 8,
  },
  glow: {
    shadowColor: colors.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.30,
    shadowRadius: 12,
    elevation: 6,
  },
};

export const formatINR = (n: number | null | undefined) => {
  if (n === null || n === undefined || isNaN(n as number)) return '₹—';
  const v = Number(n);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN')}`;
};

export const formatINRFull = (n: number) => `₹${Number(n).toLocaleString('en-IN')}`;

/**
 * Privacy mask for vehicle registration numbers.
 *
 * Dealers (and any non-owner role) MUST NOT see the full plate of
 * another seller's vehicle. We expose only the first 4 characters
 * (state code + RTO) and replace the remainder with asterisks.
 *
 *   MH02XYA002  →  MH02******
 *   TS09AB1234  →  TS09******
 *
 * Use sparingly — operators and the vehicle owner (seller) still see
 * the full registration number; only call this in dealer-facing
 * surfaces.
 */
export const maskRegNo = (reg?: string | null): string => {
  if (!reg) return '—';
  const s = String(reg).replace(/\s+/g, '').toUpperCase();
  if (s.length <= 4) return s;
  return s.slice(0, 4) + '*'.repeat(Math.max(6, s.length - 4));
};

/**
 * Bottom-padding helper for ScrollView/FlatList content inside a tab
 * screen. Returns the live bottom tab bar height (which already
 * includes the system gesture inset thanks to /(tabs)/_layout.tsx and
 * /(admin)/_layout.tsx) plus a small visual buffer so the last list
 * row is never clipped behind the floating tab bar.
 *
 * Falls back gracefully when called outside a Tab navigator (for
 * example in the seller portal or the auth flow) — returns the buffer
 * alone so screens stay safe to consume the same hook.
 *
 * Use exactly like:
 *   const tabPad = useTabBottomPad();
 *   <ScrollView contentContainerStyle={{ paddingBottom: tabPad }} />
 *
 * The dealer shell uses a FLOATING navigation tray (not a fixed bar),
 * so `useBottomTabBarHeight()` returns 0. We supplement with an
 * explicit FLOATING_TRAY_PILL constant (pill height + margin) so
 * scrollable content stays clear of the floating pill area.
 */
const FLOATING_TRAY_PILL = 56; // 38 pill + 12 bottom margin + 6 buffer

export const useTabBottomPad = (extra = 24): number => {
  // useBottomTabBarHeight throws when not nested inside a Tab.Navigator,
  // so we wrap it. Falls back to insets.bottom + extra so seller / auth
  // screens still pad correctly above the gesture area.
  let h = 0;
  try { h = useBottomTabBarHeight(); } catch { h = 0; }
  const insets = useSafeAreaInsets();
  // When h === 0 (floating tray case) we add the pill clearance.
  const pillExtra = h === 0 ? FLOATING_TRAY_PILL : 0;
  return (h || insets.bottom) + pillExtra + extra;
};


