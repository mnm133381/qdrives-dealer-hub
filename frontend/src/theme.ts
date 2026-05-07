// Q Drives — Design tokens
// Premium automotive dealer-auction infrastructure palette.
// Refined per brand spec: matte black, gunmetal panels, controlled red,
// chrome/silver muted to gunmetal. NOT a gaming/esports look.
export const colors = {
  bg: '#050505',           // pure matte black
  bgCard: '#0E1016',       // secondary panel
  bgElevated: '#13161E',   // raised surfaces (operator panels, modals)
  bgOverlay: 'rgba(5, 5, 5, 0.88)',

  textPrimary: '#F5F7FA',  // bright white reserved for headings & data
  textChrome: '#D6DAE2',   // body text on dark
  textSecondary: '#9099A6',
  textMuted: '#6B7280',

  red: '#D4141E',          // primary accent — sharper than B91C1C
  redHover: '#B30F18',
  redPulse: 'rgba(212, 20, 30, 0.22)',
  redGlow: 'rgba(212, 20, 30, 0.32)',  // softened halo
  silver: '#B7BDC9',       // gunmetal/chrome muted

  border: '#20232B',       // softer borders, less neon line work
  borderFocus: '#3A3F4A',

  success: '#10B981',
  successBg: 'rgba(16, 185, 129, 0.10)',
  warning: '#F59E0B',
  warningBg: 'rgba(245, 158, 11, 0.10)',
  danger: '#EF4444',
  info: '#3B82F6',
};

export const radii = {
  sm: 6,
  md: 10,        // medium-only per brand spec — not 12+
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
  // Restrained shadow — removes the "oversized neon glow" feel
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 3,
  },
  glow: {
    shadowColor: colors.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.32,    // restrained ambient red glow
    shadowRadius: 10,
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
