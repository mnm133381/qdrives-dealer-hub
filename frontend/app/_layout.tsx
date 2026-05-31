import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as NavigationBar from 'expo-navigation-bar';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/toast';
import { InspectionProvider } from '../src/inspection';
import { colors } from '../src/theme';
import { InstallPrompt } from '../src/components/InstallPrompt';
import { initPwa } from '../src/pwa';

/**
 * Root layout.
 *
 * Bottom-inset / system-nav strategy (Android):
 *
 *   We embrace EDGE-TO-EDGE rendering (`app.json` →
 *   `android.edgeToEdgeEnabled: true`). On Android 15+ (`targetSdk
 *   35`), Google ENFORCES edge-to-edge in release builds regardless
 *   of any flag — so trying to disable it is a losing battle. Instead
 *   we lean in:
 *
 *     1. Android paints the system bars as TRANSLUCENT overlays
 *        over our app surface.
 *     2. `useSafeAreaInsets()` returns the real gesture/3-button
 *        bar inset (e.g. 24-30dp on Samsung gesture nav, 0 on
 *        3-button nav where Android pushes our window up).
 *     3. The tab bar layouts apply
 *           paddingBottom: Math.max(insets.bottom + 8, 24)
 *        so the bar always has at least 24dp clearance and grows
 *        naturally to ~32dp on Samsung gesture nav, ~36dp on Pixel.
 *
 *   This matches the WORKING preview behavior in PRODUCTION builds
 *   too — fixing the prior issue where release APKs collapsed the
 *   tab bar into the system gesture area.
 *
 *   Note: with edge-to-edge enabled, `NavigationBar.set*ColorAsync`
 *   and `setBehaviorAsync` are no-ops — Android owns those entirely.
 *   We still set `setButtonStyleAsync('light')` so the system nav
 *   icons render in light style on our dark app surface.
 */
export default function RootLayout() {
  // Edge-to-edge — most NavigationBar APIs are no-ops, but the
  // button-style call still controls icon contrast (light/dark) on
  // the system nav. Wrapped in try/catch for older devices.
  useEffect(() => {
    if (Platform.OS === 'web') {
      // PWA bootstrap: capture beforeinstallprompt, listen for SW
      // update + deep-link events. Idempotent — safe across remounts.
      initPwa();
      return;
    }
    if (Platform.OS !== 'android') return;
    (async () => {
      try {
        await NavigationBar.setButtonStyleAsync('light');
      } catch {
        // safe to ignore — fallback to system default
      }
    })();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <AuthProvider>
          <ToastProvider>
            <InspectionProvider>
              <StatusBar
                style="light"
                backgroundColor={Platform.OS === 'android' ? '#08080A' : undefined}
                translucent={false}
              />
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.bg },
                  animation: 'slide_from_right',
                }}
              >
                <Stack.Screen name="index" options={{ animation: 'fade' }} />
                <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
                <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
                <Stack.Screen name="(admin)" options={{ animation: 'fade' }} />
                <Stack.Screen name="notifications" options={{ animation: 'slide_from_right' }} />
                {/* Nested folder routes (auction/[id], my-listings/index, sell/inspection)
                    are auto-discovered by expo-router. DO NOT register them as
                    Stack.Screen entries with slashes in the name — that registration
                    overrides the file-based route and causes /auction/{id} to
                    redirect to /. Per-screen animations now default from screenOptions. */}
              </Stack>
              {/* PWA install + update prompts (web only — native renders nothing). */}
              <InstallPrompt />
            </InspectionProvider>
          </ToastProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
