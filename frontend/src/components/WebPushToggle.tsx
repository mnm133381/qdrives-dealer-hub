import React, { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator } from 'react-native';
import { BellRing, BellOff } from 'lucide-react-native';
import { colors } from '../theme';
import { useToast } from '../toast';
import {
  isWebPushSupported,
  isWebPushConfigured,
  currentPermission,
  enableWebPush,
  disableWebPush,
  isPushPromptSuppressed,
} from '../webPush';

/**
 * "Enable Notifications" toggle for the PWA.
 *
 * Renders nothing on native (iOS/Android apps already have OS-level
 * push permission flows handled at sign-in). On web, surfaces the
 * current state and provides a tappable CTA:
 *
 *   - Not supported   → silent no-op (returns null).
 *   - VAPID missing   → shows a disabled badge with explainer.
 *   - Permission default → "Enable notifications" CTA → triggers browser prompt.
 *   - Permission granted → "On — tap to disable" CTA → deletes FCM token + clears suppression.
 *   - Permission denied → instructions to unblock via browser site settings.
 *
 * Critical UX rule: never auto-prompt the user. The browser permission
 * dialog only fires in response to this explicit tap.
 */
export function WebPushToggle() {
  const toast = useToast();
  const [permission, setPermission] = useState<NotificationPermission | 'default'>('default');
  const [supported, setSupported] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setSupported(isWebPushSupported());
    setConfigured(isWebPushConfigured());
    setPermission(currentPermission());
  }, []);

  const refresh = useCallback(() => {
    setPermission(currentPermission());
    setConfigured(isWebPushConfigured());
  }, []);

  const handleEnable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const token = await enableWebPush();
      refresh();
      if (token) {
        toast.show('Notifications enabled', 'success');
      } else if (Notification.permission === 'denied') {
        toast.show('Notifications blocked — enable from your browser settings', 'error');
      } else {
        toast.show('Notifications not enabled', 'info');
      }
    } catch (e: any) {
      toast.show(e?.message || 'Could not enable notifications', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, toast, refresh]);

  const handleDisable = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await disableWebPush();
      toast.show('Notifications turned off', 'info');
    } catch {
      // swallow
    } finally {
      setBusy(false);
      refresh();
    }
  }, [busy, toast, refresh]);

  // Native — render nothing.
  if (Platform.OS !== 'web') return null;
  // Unsupported browser — quietly hide. (Lighthouse won't ding for missing CTA.)
  if (!supported) return null;

  // VAPID not configured — show a passive "Setup pending" badge so admins
  // know the rest of the UI is fine and only the key is missing.
  if (!configured) {
    return (
      <View style={[styles.row, styles.rowDisabled]}>
        <View style={styles.iconBubbleMuted}>
          <BellOff size={18} color={colors.textMuted} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.title}>Push notifications</Text>
          <Text style={styles.bodyMuted}>Setup pending — admin must configure FCM web push.</Text>
        </View>
      </View>
    );
  }

  // Permission denied — guide the user to browser site settings.
  if (permission === 'denied') {
    return (
      <View style={[styles.row, styles.rowDisabled]}>
        <View style={styles.iconBubbleMuted}>
          <BellOff size={18} color={colors.warning} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.title}>Notifications blocked</Text>
          <Text style={styles.bodyMuted}>Allow from your browser site settings to receive bid alerts.</Text>
        </View>
      </View>
    );
  }

  // Permission granted — show ON + tap-to-disable.
  if (permission === 'granted') {
    return (
      <TouchableOpacity
        onPress={handleDisable}
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel="Turn off push notifications"
        activeOpacity={0.8}
        disabled={busy}
        testID="webpush-disable"
      >
        <View style={styles.iconBubbleOn}>
          <BellRing size={18} color={colors.success} />
        </View>
        <View style={styles.copy}>
          <Text style={styles.title}>Notifications on</Text>
          <Text style={styles.bodyMuted}>Bid alerts, outbid warnings and live auction updates.</Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={colors.textMuted} />
        ) : (
          <Text style={styles.cta}>Turn off</Text>
        )}
      </TouchableOpacity>
    );
  }

  // Permission default — show CTA.
  const wasSuppressed = isPushPromptSuppressed();
  return (
    <TouchableOpacity
      onPress={handleEnable}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel="Enable push notifications"
      activeOpacity={0.8}
      disabled={busy}
      testID="webpush-enable"
    >
      <View style={styles.iconBubble}>
        <BellRing size={18} color={colors.red} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>Enable notifications</Text>
        <Text style={styles.bodyMuted}>
          {wasSuppressed
            ? 'Get instant alerts on outbids, wins and new lots.'
            : 'Stay on top of outbids and live auction kicks.'}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={colors.red} />
      ) : (
        <Text style={[styles.cta, { color: colors.red }]}>Enable</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: '#11111A',
    borderRadius: 12,
    borderColor: '#27272A',
    borderWidth: 1,
    marginTop: 8,
    minHeight: 56,
  },
  rowDisabled: {
    opacity: 0.85,
  },
  iconBubble: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(185, 28, 28, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBubbleOn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(34, 197, 94, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBubbleMuted: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors?.text || '#FAFAFA',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  bodyMuted: {
    color: colors?.textMuted || '#A3A3A3',
    fontSize: 12,
    lineHeight: 16,
  },
  cta: {
    color: colors?.textMuted || '#A3A3A3',
    fontSize: 13,
    fontWeight: '600',
  },
});
