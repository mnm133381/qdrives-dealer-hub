/**
 * FloatingNavTray — pull-up dealer navigation.
 *
 * Replaces the fixed bottom tab bar with a compact floating tray that
 * never collides with the Android system gesture / 3-button nav area.
 *
 * Two states:
 *
 *   COLLAPSED (default, always visible)
 *     A centred pill ~140dp wide showing the active route's icon +
 *     label + a chevron-up affordance. Floats above the OS system
 *     nav with a healthy margin (>= insets.bottom + 12dp).
 *
 *   EXPANDED (after tap on pill or swipe-up gesture)
 *     A full-width tray with all 5 nav targets as icon + label
 *     buttons. Tap any → navigate + auto-collapse. Swipe down or tap
 *     the dark backdrop → collapse. NO time-based auto-collapse —
 *     dealers may pause to evaluate listings without losing the
 *     tray.
 *
 * Animation: react-native-reanimated spring (damping 18, stiffness
 * 200). Gesture: react-native-gesture-handler pan, vertical only.
 *
 * Wiring: passed as the `tabBar` prop on the dealer `<Tabs>` in
 * `app/(tabs)/_layout.tsx`. The default `tabBarStyle` declares
 * `height: 0` so React Navigation does not reserve space; the tray
 * floats over screen content. Each tab screen continues to pad its
 * scroll content with `useTabBottomPad()` so the last list row
 * isn't hidden behind the pill.
 */
import React, { useCallback, useEffect } from 'react';
import {
  View, Text, Pressable, StyleSheet, TouchableOpacity, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming,
  interpolate, runOnJS, Extrapolation,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  Home, Gavel, ShoppingBag, Heart, User, ChevronUp,
} from 'lucide-react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { colors, radii } from '../theme';

// Map expo-router file names → icon + label
const NAV_META: Record<string, { Icon: any; label: string }> = {
  index:     { Icon: Home,        label: 'Home' },
  auctions:  { Icon: Gavel,       label: 'Auctions' },
  purchases: { Icon: ShoppingBag, label: 'Purchases' },
  watchlist: { Icon: Heart,       label: 'Watchlist' },
  profile:   { Icon: User,        label: 'Profile' },
};

const PILL_HEIGHT = 38;
const TRAY_EXPANDED_HEIGHT = 108;
const SCREEN_W = Dimensions.get('window').width;

// Spring config tuned for "premium snap" — fast settle, no bounce-out
const SPRING = { damping: 22, stiffness: 240, mass: 0.8 };

/* ============================================================ */

export function FloatingNavTray({ state, navigation, descriptors }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  // 0 = collapsed pill, 1 = expanded tray
  const expanded = useSharedValue(0);
  // Live drag offset for the swipe gesture (negative = up)
  const dragDy = useSharedValue(0);

  const setExpanded = useCallback((v: 0 | 1) => {
    expanded.value = withSpring(v, SPRING);
  }, [expanded]);

  // Collapse on screen change (e.g., back-button on Android)
  useEffect(() => {
    setExpanded(0);
  }, [state.index, setExpanded]);

  // Pan gesture: vertical drag on the tray. Up = expand, down = collapse.
  const pan = Gesture.Pan()
    .activeOffsetY([-6, 6])     // require 6dp vertical movement to claim
    .failOffsetX([-12, 12])     // bail if user drags horizontally
    .onUpdate((e) => {
      'worklet';
      const startV = expanded.value;
      // Map drag distance to expansion progress, clamped 0..1
      const range = TRAY_EXPANDED_HEIGHT - PILL_HEIGHT;
      const dy = -e.translationY;        // up = positive
      const next = startV + dy / range;
      dragDy.value = Math.max(0, Math.min(1, next));
    })
    .onEnd((e) => {
      'worklet';
      const dy = -e.translationY;
      const wasOpen = expanded.value > 0.5;
      // Velocity-aware threshold so a flick always wins
      const velUp = e.velocityY < -300;
      const velDown = e.velocityY > 300;
      let target: 0 | 1;
      if (velUp) target = 1;
      else if (velDown) target = 0;
      else target = (wasOpen ? dy > -40 : dy > 40) ? 1 : 0;
      expanded.value = withSpring(target, SPRING);
      dragDy.value = withTiming(0, { duration: 180 });
    });

  // ----- Animated styles -----
  // Effective progress = max of stored expanded and live drag (drag wins
  // while user is touching, stored value resumes on release).
  const trayStyle = useAnimatedStyle(() => {
    const p = Math.max(expanded.value, dragDy.value);
    const h = PILL_HEIGHT + p * (TRAY_EXPANDED_HEIGHT - PILL_HEIGHT);
    return { height: h };
  });

  const pillStyle = useAnimatedStyle(() => {
    // Fade the collapsed pill content out as the tray expands
    const p = Math.max(expanded.value, dragDy.value);
    return {
      opacity: interpolate(p, [0, 0.4, 1], [1, 0, 0], Extrapolation.CLAMP),
    };
  });

  const tabRowStyle = useAnimatedStyle(() => {
    const p = Math.max(expanded.value, dragDy.value);
    return {
      opacity: interpolate(p, [0, 0.55, 1], [0, 0, 1], Extrapolation.CLAMP),
      transform: [{ translateY: interpolate(p, [0, 1], [16, 0], Extrapolation.CLAMP) }],
    };
  });

  // Backdrop is invisible-touchable when expanded; transparent dim layer
  const backdropStyle = useAnimatedStyle(() => {
    const p = Math.max(expanded.value, dragDy.value);
    return {
      opacity: interpolate(p, [0, 1], [0, 0.55], Extrapolation.CLAMP),
      pointerEvents: p > 0.5 ? ('auto' as const) : ('none' as const),
    };
  });

  const activeName = state.routes[state.index]?.name || 'index';
  const activeMeta = NAV_META[activeName] || NAV_META.index;
  const ActiveIcon = activeMeta.Icon;

  return (
    <>
      {/* Backdrop dim — fades in only when tray is expanded so the rest
          of the dealer surface stays untouched in the default state. */}
      <Animated.View
        style={[styles.backdrop, backdropStyle]}
        // Tap anywhere on backdrop = collapse
        onTouchStart={() => setExpanded(0)}
      />

      {/* Floating tray container — anchored to bottom, floats above
          system nav with `insets.bottom + 12` margin. */}
      <View
        pointerEvents="box-none"
        style={[
          styles.root,
          { paddingBottom: Math.max(insets.bottom, 8) + 12 },
        ]}
      >
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.tray, trayStyle]}>
            {/* Drag affordance — small horizontal grab line, always visible */}
            <View style={styles.grabHandle} />

            {/* COLLAPSED PILL CONTENT */}
            <Animated.View style={[styles.pillRow, pillStyle]} pointerEvents="box-none">
              <Pressable
                onPress={() => setExpanded(1)}
                style={styles.pillPress}
                hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
                testID="nav-pill"
              >
                <View style={styles.pillIcon}>
                  <ActiveIcon size={13} color={colors.red} strokeWidth={2.4} />
                </View>
                <Text style={styles.pillLabel} numberOfLines={1}>{activeMeta.label}</Text>
                <ChevronUp size={12} color={colors.textChrome} strokeWidth={2.6} />
              </Pressable>
            </Animated.View>

            {/* EXPANDED TAB ROW */}
            <Animated.View style={[styles.tabRow, tabRowStyle]} pointerEvents="box-none">
              {state.routes.map((route, i) => {
                const meta = NAV_META[route.name];
                if (!meta) return null;
                const isActive = i === state.index;
                const TabIcon = meta.Icon;
                const onPress = () => {
                  if (!isActive) {
                    const ev = navigation.emit({
                      type: 'tabPress',
                      target: route.key,
                      canPreventDefault: true,
                    });
                    if (!ev.defaultPrevented) navigation.navigate(route.name as any);
                  }
                  setExpanded(0);
                };
                return (
                  <TouchableOpacity
                    key={route.key}
                    onPress={onPress}
                    activeOpacity={0.7}
                    style={styles.tab}
                    testID={`nav-tab-${route.name}`}
                  >
                    <View style={[styles.tabIcon, isActive && styles.tabIconActive]}>
                      <TabIcon
                        size={18}
                        color={isActive ? colors.red : colors.textChrome}
                        strokeWidth={isActive ? 2.4 : 2}
                      />
                    </View>
                    <Text
                      style={[styles.tabLabel, isActive && styles.tabLabelActive]}
                      numberOfLines={1}
                    >
                      {meta.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  /* Backdrop */
  backdrop: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0, right: 0,
    backgroundColor: '#000',
  },

  /* Root container — pinned to bottom, floats above OS system nav */
  root: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    alignItems: 'center',
  },

  /* Tray surface — premium dark elevated card */
  tray: {
    width: Math.min(SCREEN_W - 24, 480),
    borderRadius: 20,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
    // Strong shadow for clear floating depth
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 18,
    elevation: 18,
  },

  /* Drag handle line at top of tray, always visible */
  grabHandle: {
    width: 36, height: 3.5,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignSelf: 'center',
    marginTop: 6,
  },

  /* COLLAPSED pill */
  pillRow: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    height: PILL_HEIGHT,
  },
  pillPress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  pillIcon: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(255,30,45,0.10)',
    borderWidth: 1, borderColor: 'rgba(255,30,45,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  pillLabel: {
    color: colors.textPrimary,
    fontSize: 12.5, fontWeight: '800', letterSpacing: 0.2,
  },

  /* EXPANDED tab row */
  tabRow: {
    position: 'absolute',
    bottom: 14, left: 0, right: 0,
    flexDirection: 'row',
    paddingHorizontal: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 6,
  },
  tabIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  tabIconActive: {
    backgroundColor: 'rgba(255,30,45,0.10)',
    borderWidth: 1, borderColor: 'rgba(255,30,45,0.40)',
  },
  tabLabel: {
    fontSize: 10, fontWeight: '700',
    color: colors.textMuted, letterSpacing: 0.3,
  },
  tabLabelActive: { color: colors.red },
});
