import React from 'react';
import { View, StyleSheet } from 'react-native';
import { colors } from '../theme';

export function Skeleton({ width, height, style }: { width: number | string; height: number; style?: any }) {
  return <View style={[styles.box, { width, height }, style]} />;
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.bgElevated,
    borderRadius: 8,
    overflow: 'hidden',
  },
});
