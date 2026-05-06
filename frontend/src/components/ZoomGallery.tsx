/**
 * ZoomGallery — lightweight pinch-to-zoom + double-tap zoom + horizontal swipe
 * gallery built on react-native-gesture-handler v2 + reanimated 4.
 *
 * Designed for premium B2B auction galleries where dealers need to inspect
 * fine details (dents, VIN plates, odometer, tyre tread) without the
 * library bloat / Reanimated 3↔4 incompatibility of `awesome-gallery`.
 *
 * Usage:
 *   <ZoomGallery
 *     uris={['https://...', 'https://...']}
 *     initialIndex={2}
 *     onIndexChange={(i) => ...}
 *     onClose={() => ...}
 *   />
 */
import React, { useState } from 'react';
import { View, StyleSheet, Dimensions, FlatList, Platform } from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, withTiming, runOnJS,
} from 'react-native-reanimated';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const MIN_SCALE = 1;
const MAX_SCALE = 4.5;
const DOUBLE_TAP_SCALE = 2.5;

type Props = {
  uris: string[];
  initialIndex?: number;
  onIndexChange?: (i: number) => void;
  onClose?: () => void;
};

export function ZoomGallery({ uris, initialIndex = 0, onIndexChange, onClose }: Props) {
  const [activeIndex, setActiveIndex] = useState(initialIndex);

  return (
    <FlatList
      data={uris}
      horizontal
      pagingEnabled
      keyExtractor={(_, i) => `g_${i}`}
      initialScrollIndex={initialIndex}
      getItemLayout={(_, index) => ({ length: SCREEN_W, offset: SCREEN_W * index, index })}
      showsHorizontalScrollIndicator={false}
      onMomentumScrollEnd={(e) => {
        const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
        if (i !== activeIndex) {
          setActiveIndex(i);
          onIndexChange?.(i);
        }
      }}
      renderItem={({ item }) => (
        <ZoomablePage uri={item} onSwipeDownClose={onClose} />
      )}
      style={{ flex: 1 }}
    />
  );
}

function ZoomablePage({ uri, onSwipeDownClose }: { uri: string; onSwipeDownClose?: () => void }) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const reset = () => {
    'worklet';
    scale.value = withSpring(1, { damping: 18 });
    tx.value = withSpring(0, { damping: 18 });
    ty.value = withSpring(0, { damping: 18 });
    savedScale.value = 1; savedTx.value = 0; savedTy.value = 0;
  };

  const closeFromJs = () => onSwipeDownClose?.();

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
      scale.value = next;
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value < 1.05) {
        scale.value = withSpring(1);
        tx.value = withSpring(0);
        ty.value = withSpring(0);
        savedScale.value = 1; savedTx.value = 0; savedTy.value = 0;
      }
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .minPointers(1)
    .onUpdate((e) => {
      // When scaled in, pan moves the image.
      if (scale.value > 1.02) {
        tx.value = savedTx.value + e.translationX;
        ty.value = savedTy.value + e.translationY;
      } else if (Math.abs(e.translationY) > 80 && Math.abs(e.translationX) < 60) {
        // Vertical drag while not zoomed → swipe-down to close
        ty.value = e.translationY;
      }
    })
    .onEnd((e) => {
      if (scale.value <= 1.02) {
        // Swipe-down threshold
        if (Math.abs(e.translationY) > 120) {
          runOnJS(closeFromJs)();
        }
        ty.value = withSpring(0);
        return;
      }
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDelay(280)
    .onEnd(() => {
      if (scale.value > 1.05) {
        reset();
      } else {
        scale.value = withTiming(DOUBLE_TAP_SCALE, { duration: 200 });
        savedScale.value = DOUBLE_TAP_SCALE;
      }
    });

  const composed = Gesture.Simultaneous(pinch, pan, doubleTap);

  const aStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={styles.page}>
        <Animated.View style={[styles.imageWrap, aStyle]}>
          <Image source={{ uri }} style={styles.image} contentFit="contain" cachePolicy="memory-disk" transition={120} />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  page: { width: SCREEN_W, height: SCREEN_H, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  imageWrap: { width: SCREEN_W, height: SCREEN_H, alignItems: 'center', justifyContent: 'center' },
  image: { width: SCREEN_W, height: SCREEN_H * 0.86 },
});
