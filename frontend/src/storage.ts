/**
 * Q Drives — Safe storage wrapper.
 *
 * Uses @react-native-async-storage/async-storage when available.
 * Falls back to an in-memory store if the native module isn't ready
 * (e.g. SSR pre-hydration on Expo Web, or Expo Go modules not yet linked).
 *
 * All operations are NEVER allowed to throw — the app must keep running
 * even when storage is unavailable. The user just won't have persistence
 * across reloads in that fallback path.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const memory: Record<string, string> = {};

function isNativeReady(): boolean {
  try {
    // Both modern and legacy module shapes should expose getItem.
    return !!AsyncStorage && typeof AsyncStorage.getItem === 'function';
  } catch {
    return false;
  }
}

export const storage = {
  async getItem(key: string): Promise<string | null> {
    if (!isNativeReady()) return memory[key] ?? null;
    try {
      const v = await AsyncStorage.getItem(key);
      return v;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[storage] getItem failed, using memory fallback:', e);
      return memory[key] ?? null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    memory[key] = value;
    if (!isNativeReady()) return;
    try {
      await AsyncStorage.setItem(key, value);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[storage] setItem failed, kept in memory:', e);
    }
  },
  async removeItem(key: string): Promise<void> {
    delete memory[key];
    if (!isNativeReady()) return;
    try {
      await AsyncStorage.removeItem(key);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[storage] removeItem failed:', e);
    }
  },
};
