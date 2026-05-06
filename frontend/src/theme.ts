// Q Drives — Design tokens (mirrors /app/design_guidelines.json for native app)
export const colors = {
  bg: '#0B0B0D',
  bgCard: '#16181D',
  bgElevated: '#1A1C23',
  bgOverlay: 'rgba(11, 11, 13, 0.85)',

  textPrimary: '#F8FAFC',
  textChrome: '#E2E8F0',
  textSecondary: '#94A3B8',
  textMuted: '#64748B',

  red: '#B91C1C',
  redHover: '#991B1B',
  redPulse: 'rgba(185, 28, 28, 0.28)',
  redGlow: 'rgba(185, 28, 28, 0.45)',
  silver: '#CBD5E1',

  border: '#2A2D35',
  borderFocus: '#475569',

  success: '#10B981',
  successBg: 'rgba(16, 185, 129, 0.10)',
  warning: '#F59E0B',
  warningBg: 'rgba(245, 158, 11, 0.10)',
  danger: '#EF4444',
  info: '#3B82F6',
};

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
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
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 6,
  },
  glow: {
    shadowColor: colors.red,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 10,
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
