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

/**
 * Root layout.
 *
 * Bottom-inset / system nav strategy (Android):
 *
 *   1. `app.json` → `edgeToEdgeEnabled: false` keeps the system 3-button
 *      nav opaque + non-overlapping at the OS layer.
 *
 *   2. `app.json` → `androidNavigationBar.backgroundColor: #08080A` and
 *      runtime `NavigationBar.setBackgroundColorAsync('#08080A')` paints
 *      the system nav matching `colors.bg` so it visually disappears
 *      into the app surface even on Samsung One UI which otherwise
 *      defaults to opaque white.
 *
 *   3. Tab bar layouts apply `paddingBottom: Math.max(insets.bottom + 8,
 *      24)` so even if Samsung mis-reports the inset, our tab bar still
 *      keeps a 24dp safety strip above the system nav.
 *
 *   Net effect: nothing overlaps the system nav on Samsung One UI,
 *   Pixel, OnePlus, or any aspect ratio. Bulletproof on real devices.
 */
export default function RootLayout() {
  // Configure Android system nav bar at runtime. This is required for
  // Samsung One UI compatibility — the static app.json
  // `androidNavigationBar` config does not always persist across boots
  // on One UI 5+. Calling it once on mount guarantees the bar matches
  // our app surface.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    (async () => {
      try {
        await NavigationBar.setBackgroundColorAsync('#08080A');
        await NavigationBar.setButtonStyleAsync('light');
        await NavigationBar.setBehaviorAsync('overlay-swipe');
      } catch {
        // expo-navigation-bar throws on Android Go / very old devices;
        // safe to ignore — fallback to app.json defaults.
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
            </InspectionProvider>
          </ToastProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
