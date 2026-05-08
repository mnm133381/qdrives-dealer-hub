/**
 * Seller route group layout.
 *
 * Sellers are vehicle-owners — a controlled visibility layer ON TOP OF
 * the existing auction system. This layout wraps three screens:
 *   /(seller)/login        — OTP sign-in
 *   /(seller)/             — list of linked vehicles
 *   /(seller)/vehicle/[id] — sanitized read-only tracking
 */
import React from 'react';
import { Stack } from 'expo-router';
import { colors } from '../../src/theme';

export default function SellerLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="login" />
      <Stack.Screen name="index" />
      <Stack.Screen name="vehicle/[id]" />
    </Stack>
  );
}
