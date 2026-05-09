import React from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/auth';
import { ToastProvider } from '../src/toast';
import { InspectionProvider } from '../src/inspection';
import { colors } from '../src/theme';

/**
 * Root layout.
 *
 * Bottom-inset / system nav strategy (Android):
 *   `app.json` → `edgeToEdgeEnabled: false` keeps the system 3-button
 *   nav opaque + non-overlapping, and `androidNavigationBar` paints
 *   it deep-black (matches `colors.bg`) so it visually disappears
 *   into the app surface. The tab bar layouts then add `insets.bottom`
 *   on top — which is 0 on 3-button-nav devices (Android already
 *   pushed our window up) and ~24-30dp on gesture-nav devices.
 *
 *   Net effect: nothing overlaps the system nav on Samsung One UI,
 *   Pixel, OnePlus, or any aspect ratio. No screen-by-screen padding
 *   hacks needed.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <AuthProvider>
          <ToastProvider>
            <InspectionProvider>
              <StatusBar
                style="light"
                backgroundColor={Platform.OS === 'android' ? '#050505' : undefined}
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
