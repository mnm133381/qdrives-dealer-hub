import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react-native';
import { colors, radii } from './theme';

type ToastKind = 'success' | 'error' | 'info';
type Toast = { id: string; kind: ToastKind; message: string };
type Ctx = { show: (message: string, kind?: ToastKind) => void };

const ToastContext = createContext<Ctx>({ show: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-30)).current;
  const timerRef = useRef<any>(null);

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    setToast({ id: Math.random().toString(36).slice(2), kind, message });
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true, easing: Easing.out(Easing.ease) }),
      Animated.timing(translateY, { toValue: 0, duration: 250, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
    ]).start();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: -30, duration: 250, useNativeDriver: true }),
      ]).start(() => setToast(null));
    }, 2200);
  }, [opacity, translateY]);

  const Icon = toast?.kind === 'success' ? CheckCircle2 : toast?.kind === 'error' ? AlertTriangle : Info;
  const accent = toast?.kind === 'success' ? colors.success : toast?.kind === 'error' ? colors.red : colors.info;

  // Memoize the context value so consumer components that depend on it
  // in their useCallback/useEffect deps don't recreate on every render
  // of this provider — that previously caused infinite-loop refetches
  // in the lot screen (load() ↔ toast.show() ↔ re-render cycle).
  const ctxValue = useMemo<Ctx>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={ctxValue}>
      {children}
      {toast && (
        <Animated.View pointerEvents="none" style={[styles.wrap, { opacity, transform: [{ translateY }] }]}>
          <View style={[styles.toast, { borderColor: `${accent}66` }]}>
            <Icon size={18} color={accent} />
            <Text style={styles.text} numberOfLines={2}>{toast.message}</Text>
          </View>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 50, left: 0, right: 0, alignItems: 'center', zIndex: 9999, pointerEvents: 'none' },
  toast: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: colors.bgElevated,
    borderColor: colors.border, borderWidth: 1,
    paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: radii.md, maxWidth: 360,
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.5, shadowRadius: 16, elevation: 12,
  },
  text: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', flex: 1 },
});
