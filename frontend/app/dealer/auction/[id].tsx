/**
 * Dealer-scoped auction detail route — `/dealer/auction/[id]`.
 *
 * This is a thin Redirect alias that resolves the URL the user mandated
 * in the cleanup brief to the canonical detail screen at /auction/[id].
 * Keeping a single underlying screen avoids duplicating the WebSocket /
 * bid-feed / inspection logic in two places. Both routes lead to the
 * same UX, the same auth gating, and the same backend contract.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function DealerAuctionAlias() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return <Redirect href="/(tabs)" />;
  return <Redirect href={`/auction/${id}` as any} />;
}
