import React, { useEffect, useState, useCallback } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  initPwa,
  isWeb,
  isStandalone,
  isInstallable,
  isIosSafariEligible,
  isPromptSuppressed,
  onInstallReady,
  onUpdateReady,
  showInstallPrompt,
  suppressPromptForDays,
  applyUpdate,
} from '../pwa';
import { colors } from '../theme';

/**
 * Soft "Add to Home Screen" + "Update available" UI for QD Auctions PWA.
 *
 * Rendering rules:
 *   - Native (iOS/Android app): renders nothing.
 *   - Desktop web: only shows the update banner (install rarely useful).
 *   - Mobile web in Chrome/Edge/Samsung Internet: shows install banner
 *     once `beforeinstallprompt` fires AND the user hasn't dismissed
 *     within the last 7 days.
 *   - iOS Safari: shows iOS-specific A2HS instructions (Share → Add to
 *     Home Screen) because iOS never fires beforeinstallprompt.
 *
 * The banner is positioned just above the bottom tab bar so it doesn't
 * interfere with primary navigation. Tapping outside dismisses it but
 * keeps it eligible for re-show on the next session.
 */
export function InstallPrompt() {
  const [installReady, setInstallReady] = useState<boolean>(false);
  const [updateReady, setUpdateReady] = useState<boolean>(false);
  const [iosHint, setIosHint] = useState<boolean>(false);
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    if (!isWeb()) return;
    initPwa();

    if (isStandalone()) return; // already installed
    if (isPromptSuppressed()) { setDismissed(true); return; }

    const unsubInstall = onInstallReady(() => setInstallReady(isInstallable()));
    const unsubUpdate = onUpdateReady(() => setUpdateReady(true));

    // iOS Safari has no beforeinstallprompt — show contextual hint after 5s.
    if (isIosSafariEligible()) {
      const t = setTimeout(() => setIosHint(true), 5000);
      return () => { clearTimeout(t); unsubInstall(); unsubUpdate(); };
    }

    return () => { unsubInstall(); unsubUpdate(); };
  }, []);

  const handleInstall = useCallback(async () => {
    const outcome = await showInstallPrompt();
    if (outcome === 'dismissed') suppressPromptForDays(7);
    setInstallReady(false);
    setDismissed(true);
  }, []);

  const handleDismiss = useCallback(() => {
    suppressPromptForDays(7);
    setInstallReady(false);
    setIosHint(false);
    setDismissed(true);
  }, []);

  const handleUpdate = useCallback(() => {
    applyUpdate();
  }, []);

  // Don't render anything on native or if user already installed/dismissed.
  if (Platform.OS !== 'web') return null;

  // Update banner takes priority over install banner.
  if (updateReady) {
    return (
      <View style={styles.banner} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.iconBubble}>
            <Text style={styles.iconText}>↑</Text>
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>New version available</Text>
            <Text style={styles.body}>Refresh to load the latest QD Auctions update.</Text>
          </View>
          <TouchableOpacity
            onPress={handleUpdate}
            style={styles.primaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Refresh to update QD Auctions"
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>Refresh</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (dismissed) return null;

  if (installReady) {
    return (
      <View style={styles.banner} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.iconBubble}>
            <Text style={styles.iconText}>⬇</Text>
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>Install QD Auctions</Text>
            <Text style={styles.body}>Faster loads, push alerts, works offline.</Text>
          </View>
          <TouchableOpacity
            onPress={handleInstall}
            style={styles.primaryBtn}
            accessibilityRole="button"
            accessibilityLabel="Install QD Auctions as a web app"
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>Install</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleDismiss}
            style={styles.closeBtn}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss install prompt"
          >
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (iosHint) {
    return (
      <View style={styles.banner} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.iconBubble}>
            <Text style={styles.iconText}>⬆</Text>
          </View>
          <View style={styles.copy}>
            <Text style={styles.title}>Add to Home Screen</Text>
            <Text style={styles.body}>Tap Share, then “Add to Home Screen”.</Text>
          </View>
          <TouchableOpacity
            onPress={handleDismiss}
            style={styles.closeBtn}
            hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss install hint"
          >
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    // safe-area for iOS notch; web ignores RN paddingBottom ‘env(...)’ trick,
    // so we just leave a generous 16dp clearance.
    paddingBottom: 16,
    zIndex: 9999,
    elevation: 9999,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#11111A',
    borderColor: '#27272A',
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 12,
    maxWidth: 560,
    alignSelf: 'center',
    width: '100%',
  },
  iconBubble: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(185, 28, 28, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {
    color: '#B91C1C',
    fontSize: 18,
    fontWeight: '700',
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
  body: {
    color: colors?.muted || '#A3A3A3',
    fontSize: 12,
    lineHeight: 16,
  },
  primaryBtn: {
    backgroundColor: '#B91C1C',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  closeBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: '#A3A3A3',
    fontSize: 14,
  },
});
