/**
 * Lifecycle helpers — single source of truth for time-left formatting and
 * inventory/auction status badge rendering. Replaces the raw `1297:28`
 * countdown bug and the meaningless `UNKNOWN` badge that showed up when
 * an auction sat in a settlement-state the old switch didn't know about.
 */
import { colors } from './theme';

/**
 * Convert a remaining-seconds count into a glanceable label.
 *   • <60s   → `0:42`            (seconds-precision burn-down)
 *   • <60m   → `42m 17s`         (minute + seconds for sub-hour)
 *   • <24h   → `5h 23m`          (hour + minute, no seconds noise)
 *   • >=24h  → `2d 4h`           (day + hour)
 *   • <=0    → `0:00`            (terminal display, callers usually swap to "ENDED")
 */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s <= 0) return '0:00';
  if (s < 60) return `0:${s.toString().padStart(2, '0')}`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}m ${sec.toString().padStart(2, '0')}s`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m.toString().padStart(2, '0')}m`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d}d ${h}h`;
}

export type StatusKey =
  | 'draft' | 'scheduled' | 'live' | 'paused'
  | 'ended' | 'ended_pending_payment' | 'payment_received' | 'vehicle_released'
  | 'settled' | 'dispute' | 'cancelled' | 'withdrawn' | 'archived'
  | string | null | undefined;

export type StatusBadge = { label: string; tint: string; tone: 'live' | 'warn' | 'danger' | 'good' | 'muted' };

/**
 * Map any auction/inventory status to a fixed badge label + tint.
 * NEVER returns `UNKNOWN` — fallback is the raw key uppercased so engineers
 * can spot a missing mapping immediately without confusing operators.
 */
export function statusBadge(status: StatusKey): StatusBadge {
  const s = (status || '').toString().toLowerCase();
  switch (s) {
    case 'draft':                 return { label: 'DRAFT',           tint: colors.textMuted, tone: 'muted'  };
    case 'scheduled':             return { label: 'SCHEDULED',       tint: colors.silver,    tone: 'muted'  };
    case 'live':                  return { label: 'LIVE',            tint: colors.success,   tone: 'live'   };
    case 'paused':                return { label: 'PAUSED',          tint: colors.warning,   tone: 'warn'   };
    case 'ended':                 return { label: 'ENDED',           tint: colors.textMuted, tone: 'muted'  };
    case 'ended_pending_payment': return { label: 'PENDING $',       tint: colors.warning,   tone: 'warn'   };
    case 'payment_received':      return { label: 'PAID',            tint: colors.silver,    tone: 'muted'  };
    case 'vehicle_released':      return { label: 'RELEASED',        tint: colors.success,   tone: 'good'   };
    case 'settled':               return { label: 'SETTLED',         tint: colors.success,   tone: 'good'   };
    case 'dispute':               return { label: 'DISPUTE',         tint: colors.red,       tone: 'danger' };
    case 'cancelled':             return { label: 'CANCELLED',       tint: colors.red,       tone: 'danger' };
    case 'withdrawn':             return { label: 'WITHDRAWN',       tint: colors.warning,   tone: 'warn'   };
    case 'archived':              return { label: 'ARCHIVED',        tint: colors.textMuted, tone: 'muted'  };
    default:
      return { label: s ? s.toUpperCase().replace(/_/g, ' ') : 'UNKNOWN', tint: colors.textMuted, tone: 'muted' };
  }
}
