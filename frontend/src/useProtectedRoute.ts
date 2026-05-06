import { useEffect } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { useAuth } from './auth';

/**
 * Auto-redirects user based on auth state.
 * - If not authed and inside protected group -> /(auth)/login
 * - If authed but KYC pending and NOT inside (auth) -> /(auth)/kyc
 * - Returns true while loading.
 */
export function useProtectedRoute(): { ready: boolean; authed: boolean } {
  const { dealer, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';

    if (!dealer && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (dealer && !dealer.kyc_completed && !inAuthGroup) {
      router.replace('/(auth)/kyc');
    }
  }, [dealer, loading, segments, router]);

  return { ready: !loading, authed: !!dealer };
}
