/**
 * Dealer-scoped auction detail route — `/dealer/auction/[id]`.
 *
 * This is the canonical bid-execution surface for dealers per the
 * routing manifesto. The implementation is the existing /auction/[id]
 * screen re-exported here so we don't duplicate the WS / bid-feed /
 * inspection logic in two places. The legacy /auction/[id] route is
 * preserved as a backwards-compatible alias that redirects to this
 * canonical path.
 */
export { default } from '../../auction/[id]';
