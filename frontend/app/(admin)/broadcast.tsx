/**
 * Operator → Dealer Broadcasts (liquidity activation console).
 *
 * Marketplace-control surface, NOT a chat client. Every send is a
 * deliberate operator nudge to drive auction participation, urgency
 * and bidding velocity. Composed via:
 *
 *   1. TEMPLATE SELECTOR  — 5 presets + custom
 *   2. VEHICLE TARGET     — pick auction (required for live/reserve/ending/settlement)
 *   3. AUDIENCE TARGET    — all_verified · bidders · watchers · bidders+watchers · specific
 *   4. COMPOSER           — pre-filled title/body, vehicle context auto-injected
 *   5. PREVIEW + SEND     — what dealers receive, with confirmation
 *
 * RECENT BROADCASTS strip below the composer is the audit ledger
 * pulled from /admin/broadcasts/recent. Future work: delivery
 * telemetry, segmentation, auto-trigger event bindings.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, Modal, FlatList,
} from 'react-native';
import {
  Megaphone, Send, Users, Car as CarIcon, ChevronDown,
  Check, X, Search, Clock, ChevronRight, Radio, Zap, Trophy,
  CheckCircle2, AlertCircle, Sparkles, Edit3,
} from 'lucide-react-native';
import { colors, radii, useTabBottomPad } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';
import { AdminHeader } from '../../src/components/AdminHeader';

// ---------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------
type Template = {
  type: string;
  label: string;
  default_title: string;
  default_body: string;
  audience: string;
  needs_auction: boolean;
  tone: string;
  cta_hint: string;
};

type AuctionItem = {
  auction_id: string;
  status: string;
  current_bid: number;
  reserve_price: number;
  reserve_met: boolean;
  end_time: string | null;
  label: string;
  registration_number: string | null;
  city: string | null;
  fuel_type: string | null;
};

type Dealer = {
  id: string;
  full_name: string;
  dealership_name?: string;
  city?: string;
  verified?: boolean;
  blocked?: boolean;
};

type RecentBroadcast = {
  id: string;
  type: string;
  title: string;
  body: string;
  audience: string;
  auction_id: string | null;
  vehicle?: { year?: number; make?: string; model?: string; registration_number?: string } | null;
  recipient_count: number;
  sent_by_name: string;
  ts: string;
};

const AUDIENCES: { key: string; label: string; sub: string; needsAuction?: boolean }[] = [
  { key: 'all_verified', label: 'All verified buyers', sub: 'Every approved buyer in the network' },
  { key: 'bidders_and_watchers', label: 'Bidders + watchers', sub: 'Everyone engaged with this auction', needsAuction: true },
  { key: 'bidders', label: 'Bidders only', sub: 'Buyers who already placed a bid', needsAuction: true },
  { key: 'watchers', label: 'Watchers only', sub: 'Buyers tracking this lot', needsAuction: true },
  { key: 'specific', label: 'Specific buyers', sub: 'Manually pick recipient list' },
];

// Tone → icon mapping for templates
function templateIcon(type: string, size = 14) {
  switch (type) {
    case 'new_listing': return <Sparkles size={size} color={colors.silver} />;
    case 'auction_live': return <Radio size={size} color={colors.success} />;
    case 'reserve_met': return <CheckCircle2 size={size} color={colors.success} />;
    case 'ending_soon': return <Zap size={size} color={colors.red} />;
    case 'settlement_completed': return <Trophy size={size} color={colors.success} />;
    case 'custom': return <Edit3 size={size} color={colors.textChrome} />;
    default: return <Megaphone size={size} color={colors.textChrome} />;
  }
}

// =====================================================================
// MAIN SCREEN
// =====================================================================
export default function AdminBroadcasts() {
  const toast = useToast();
  const tabPad = useTabBottomPad();

  // Catalog data
  const [templates, setTemplates] = useState<Template[]>([]);
  const [auctions, setAuctions] = useState<AuctionItem[]>([]);
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [recents, setRecents] = useState<RecentBroadcast[]>([]);
  const [bootLoading, setBootLoading] = useState(true);

  // Composer state
  const [tplKey, setTplKey] = useState<string>('new_listing');
  const [auctionId, setAuctionId] = useState<string | null>(null);
  const [audience, setAudience] = useState<string>('all_verified');
  const [dealerIds, setDealerIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [edited, setEdited] = useState(false); // operator manually changed text
  const [busy, setBusy] = useState(false);

  // Pickers
  const [vehiclePickerOpen, setVehiclePickerOpen] = useState(false);
  const [dealerPickerOpen, setDealerPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const tpl = useMemo(() => templates.find((t) => t.type === tplKey), [templates, tplKey]);
  const selectedAuction = useMemo(
    () => auctions.find((a) => a.auction_id === auctionId) || null,
    [auctions, auctionId],
  );

  // ---------------------- Bootstrap fetch ----------------------
  const load = useCallback(async () => {
    setBootLoading(true);
    try {
      const [tpls, aucs, recs] = await Promise.all([
        api.adminBroadcastTemplates(),
        api.adminBroadcastAuctions(),
        api.adminBroadcastsRecent(20),
      ]);
      setTemplates(tpls || []);
      setAuctions(aucs || []);
      setRecents(recs || []);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load broadcast data', 'error');
    } finally { setBootLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ---------------------- Template selection ----------------------
  // When the operator picks a template, prefill title/body/audience
  // unless they have already manually edited the composer text.
  const applyTemplate = (key: string) => {
    setTplKey(key);
    const next = templates.find((t) => t.type === key);
    if (!next) return;
    setAudience(next.audience);
    if (!edited) {
      setTitle(next.default_title || '');
      setBody(next.default_body || '');
    }
    // Auto-clear auction if template no longer needs one and the operator
    // hasn't picked something specific.
    if (!next.needs_auction && audience === 'all_verified' && !auctionId) return;
  };

  // Pre-fill on first mount once templates land
  useEffect(() => {
    if (templates.length === 0) return;
    const def = templates.find((t) => t.type === tplKey);
    if (def && !edited) {
      setTitle(def.default_title || '');
      setBody(def.default_body || '');
      setAudience(def.audience);
    }
  }, [templates.length]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------- Vehicle context auto-injection ----------------------
  // When an operator picks a vehicle and they haven't manually edited the
  // body, append a vehicle line so the dealer push reads naturally.
  const previewBody = useMemo(() => {
    if (edited) return body;
    if (!selectedAuction) return body;
    const ctx = selectedAuction.label;
    if (body && body.includes(ctx)) return body;
    return `${selectedAuction.label} — ${body}`;
  }, [body, edited, selectedAuction]);

  // ---------------------- Audience requirements ----------------------
  const audienceNeedsAuction = AUDIENCES.find((a) => a.key === audience)?.needsAuction;
  const tplNeedsAuction = !!tpl?.needs_auction;
  const needsAuction = tplNeedsAuction || !!audienceNeedsAuction;
  const needsDealerPick = audience === 'specific';

  const canSend =
    title.trim().length >= 3 &&
    body.trim().length >= 5 &&
    (!needsAuction || !!auctionId) &&
    (!needsDealerPick || dealerIds.length > 0);

  // ---------------------- Send ----------------------
  const doSend = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      const payload: any = {
        type: tplKey,
        title: title.trim(),
        body: previewBody.trim(),
        audience,
      };
      if (auctionId) payload.auction_id = auctionId;
      if (audience === 'specific') payload.dealer_ids = dealerIds;

      const r = await api.adminBroadcastSend(payload);
      toast.show(
        `Broadcast sent to ${r.recipient_count} dealer${r.recipient_count === 1 ? '' : 's'}`,
        'success',
      );
      setConfirmOpen(false);
      // Reset composer back to template defaults
      setEdited(false);
      const t0 = templates.find((t) => t.type === tplKey);
      setTitle(t0?.default_title || '');
      setBody(t0?.default_body || '');
      setDealerIds([]);
      // Reload recents
      try {
        const recs = await api.adminBroadcastsRecent(20);
        setRecents(recs || []);
      } catch {}
    } catch (e: any) {
      toast.show(e.message || 'Broadcast failed', 'error');
    } finally { setBusy(false); }
  };

  // ---------------------- Lazy-load dealers when picker opens ----------------------
  const ensureDealers = useCallback(async () => {
    if (dealers.length > 0) return;
    try {
      const list = await api.adminDealers({ status_filter: 'verified' });
      setDealers(list || []);
    } catch (e: any) {
      toast.show(e.message || 'Failed to load buyers', 'error');
    }
  }, [dealers.length]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={styles.root}
    >
      <AdminHeader
        kicker="LIQUIDITY ACTIVATION"
        title="Buyer broadcasts"
        sub="Manual marketplace nudges · drive participation, urgency, and bidding velocity"
      />

      {bootLoading ? (
        <View style={styles.bootLoader}><ActivityIndicator color={colors.red} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: tabPad }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ------------------- TEMPLATE SELECTOR ------------------- */}
          <SectionLabel n="01" label="TEMPLATE" />
          <View style={styles.tplGrid}>
            {templates.map((t) => (
              <TemplateCard
                key={t.type}
                template={t}
                active={tplKey === t.type}
                onPress={() => applyTemplate(t.type)}
              />
            ))}
          </View>

          {/* ------------------- VEHICLE TARGET ------------------- */}
          <SectionLabel
            n="02"
            label="VEHICLE / INVENTORY"
            hint={needsAuction ? 'REQUIRED' : 'OPTIONAL'}
            hintTone={needsAuction ? 'required' : 'optional'}
          />
          <TouchableOpacity
            onPress={() => setVehiclePickerOpen(true)}
            style={[
              styles.fieldBtn,
              needsAuction && !auctionId && styles.fieldBtnRequired,
            ]}
            activeOpacity={0.85}
            testID="broadcast-vehicle-picker"
          >
            <View style={styles.fieldBtnIcon}><CarIcon size={14} color={colors.silver} /></View>
            <View style={{ flex: 1 }}>
              {selectedAuction ? (
                <>
                  <Text style={styles.fieldBtnTitle} numberOfLines={1}>
                    {selectedAuction.label}
                  </Text>
                  <Text style={styles.fieldBtnSub} numberOfLines={1}>
                    {selectedAuction.registration_number || '—'} ·{' '}
                    {selectedAuction.status.replace(/_/g, ' ').toUpperCase()}
                    {selectedAuction.city ? ` · ${selectedAuction.city}` : ''}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.fieldBtnPlaceholder}>
                    {needsAuction ? 'Pick a vehicle to broadcast about' : 'No specific vehicle (network-wide)'}
                  </Text>
                  <Text style={styles.fieldBtnSub}>
                    {auctions.length} auction{auctions.length === 1 ? '' : 's'} available
                  </Text>
                </>
              )}
            </View>
            {auctionId && (
              <TouchableOpacity onPress={() => setAuctionId(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <X size={14} color={colors.textMuted} />
              </TouchableOpacity>
            )}
            <ChevronDown size={14} color={colors.textMuted} />
          </TouchableOpacity>

          {/* ------------------- AUDIENCE TARGET ------------------- */}
          <SectionLabel n="03" label="AUDIENCE" />
          <View style={styles.audienceList}>
            {AUDIENCES.map((a) => {
              const disabled = a.needsAuction && !auctionId;
              const active = audience === a.key;
              return (
                <TouchableOpacity
                  key={a.key}
                  disabled={disabled}
                  onPress={() => setAudience(a.key)}
                  style={[
                    styles.audItem,
                    active && styles.audItemActive,
                    disabled && styles.audItemDisabled,
                  ]}
                  testID={`broadcast-audience-${a.key}`}
                >
                  <View style={styles.audIcon}>
                    <Users size={13} color={active ? colors.red : colors.textChrome} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.audLabel, active && { color: colors.red }]}>
                      {a.label}
                    </Text>
                    <Text style={styles.audSub}>
                      {disabled ? 'Pick a vehicle first' : a.sub}
                    </Text>
                  </View>
                  <View style={[styles.radio, active && styles.radioActive]}>
                    {active && <View style={styles.radioDot} />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* SPECIFIC DEALER PICKER (conditional) */}
          {audience === 'specific' && (
            <TouchableOpacity
              onPress={async () => { await ensureDealers(); setDealerPickerOpen(true); }}
              style={[
                styles.fieldBtn,
                { marginTop: 8 },
                dealerIds.length === 0 && styles.fieldBtnRequired,
              ]}
              activeOpacity={0.85}
              testID="broadcast-dealer-picker"
            >
              <View style={styles.fieldBtnIcon}><Users size={14} color={colors.silver} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldBtnTitle}>
                  {dealerIds.length === 0
                    ? 'Pick recipient buyers'
                    : `${dealerIds.length} dealer${dealerIds.length === 1 ? '' : 's'} selected`}
                </Text>
                <Text style={styles.fieldBtnSub}>
                  Tap to manage recipient list
                </Text>
              </View>
              <ChevronDown size={14} color={colors.textMuted} />
            </TouchableOpacity>
          )}

          {/* ------------------- COMPOSER ------------------- */}
          <SectionLabel n="04" label="MESSAGE" />
          <Text style={styles.smallLabel}>HEADLINE</Text>
          <TextInput
            value={title}
            onChangeText={(v) => { setTitle(v); setEdited(true); }}
            placeholder="e.g. 2022 Hyundai Creta SX is now live for bidding"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            maxLength={80}
          />
          <Text style={styles.hint}>{title.length}/80 · keep punchy and time-sensitive</Text>

          <Text style={[styles.smallLabel, { marginTop: 12 }]}>BODY</Text>
          <TextInput
            value={body}
            onChangeText={(v) => { setBody(v); setEdited(true); }}
            placeholder="e.g. Reserve cleared. Place your bid before the timer expires."
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.textarea]}
            multiline numberOfLines={4} textAlignVertical="top"
            maxLength={240}
          />
          <Text style={styles.hint}>
            {body.length}/240 · {!edited && selectedAuction ? 'vehicle context auto-injected on send' : 'manual override'}
          </Text>

          {/* ------------------- PREVIEW ------------------- */}
          <SectionLabel n="05" label="PREVIEW" />
          <View style={styles.previewBox}>
            <View style={styles.previewIcon}>{templateIcon(tplKey, 14)}</View>
            <View style={{ flex: 1 }}>
              <Text style={styles.previewTitle} numberOfLines={2}>
                {title || 'Your headline appears here'}
              </Text>
              <Text style={styles.previewBody} numberOfLines={4}>
                {previewBody || 'Your message body appears here.'}
              </Text>
              <Text style={styles.previewMeta}>
                {AUDIENCES.find((a) => a.key === audience)?.label || audience}
                {audience === 'specific' ? ` · ${dealerIds.length} dealer${dealerIds.length === 1 ? '' : 's'}` : ''}
                {selectedAuction ? ` · ${selectedAuction.registration_number || 'vehicle linked'}` : ''}
              </Text>
            </View>
          </View>

          {/* SEND BUTTON */}
          <TouchableOpacity
            onPress={() => setConfirmOpen(true)}
            disabled={!canSend || busy}
            style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
            activeOpacity={0.85}
            testID="broadcast-send"
          >
            {busy ? <ActivityIndicator color="#fff" /> : (
              <>
                <Send size={15} color="#fff" />
                <Text style={styles.sendBtnText}>SEND BROADCAST</Text>
              </>
            )}
          </TouchableOpacity>
          {!canSend && (
            <Text style={styles.sendHint}>
              {!title.trim() || title.trim().length < 3 ? 'Add a clearer headline · '
                : !body.trim() || body.trim().length < 5 ? 'Add a longer body · '
                : needsAuction && !auctionId ? 'Pick a vehicle · '
                : needsDealerPick && dealerIds.length === 0 ? 'Pick at least one dealer · '
                : ''}
              broadcast not ready
            </Text>
          )}

          {/* ------------------- RECENT HISTORY ------------------- */}
          <View style={styles.historyHead}>
            <Clock size={11} color={colors.textChrome} />
            <Text style={styles.historyTitle}>RECENT BROADCASTS</Text>
            <Text style={styles.historyMeta}>{recents.length} ENTRIES</Text>
          </View>
          {recents.length === 0 ? (
            <View style={styles.historyEmpty}>
              <Text style={styles.historyEmptyText}>No broadcasts on the audit ledger yet.</Text>
            </View>
          ) : (
            <View style={styles.historyList}>
              {recents.map((r, i) => (
                <HistoryRow key={r.id} row={r} last={i === recents.length - 1} />
              ))}
            </View>
          )}
        </ScrollView>
      )}

      {/* ------------------- VEHICLE PICKER MODAL ------------------- */}
      <VehiclePicker
        visible={vehiclePickerOpen}
        auctions={auctions}
        selectedId={auctionId}
        onClose={() => setVehiclePickerOpen(false)}
        onPick={(id) => { setAuctionId(id); setVehiclePickerOpen(false); }}
      />

      {/* ------------------- DEALER PICKER MODAL ------------------- */}
      <DealerPicker
        visible={dealerPickerOpen}
        dealers={dealers}
        selectedIds={dealerIds}
        onClose={() => setDealerPickerOpen(false)}
        onSubmit={(ids) => { setDealerIds(ids); setDealerPickerOpen(false); }}
      />

      {/* ------------------- CONFIRM MODAL ------------------- */}
      <ConfirmSendModal
        visible={confirmOpen}
        busy={busy}
        title={title}
        body={previewBody}
        audienceLabel={AUDIENCES.find((a) => a.key === audience)?.label || audience}
        vehicleLabel={selectedAuction?.label || null}
        regNo={selectedAuction?.registration_number || null}
        dealerCount={audience === 'specific' ? dealerIds.length : null}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={doSend}
      />
    </KeyboardAvoidingView>
  );
}

// =====================================================================
// SUB-COMPONENTS
// =====================================================================
function SectionLabel({ n, label, hint, hintTone }: { n: string; label: string; hint?: string; hintTone?: 'required' | 'optional' }) {
  return (
    <View style={styles.sectionLabelRow}>
      <Text style={styles.sectionN}>{n}</Text>
      <Text style={styles.sectionLabel}>{label}</Text>
      {hint && (
        <Text style={[
          styles.sectionHint,
          hintTone === 'required' && { color: colors.warning },
        ]}>{hint}</Text>
      )}
    </View>
  );
}

function TemplateCard({ template, active, onPress }: { template: Template; active: boolean; onPress: () => void }) {
  const toneColor =
    template.tone === 'urgent' ? colors.red :
    template.tone === 'live' ? colors.success :
    template.tone === 'success' ? colors.success :
    colors.silver;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={[styles.tplCard, active && { borderColor: colors.red, backgroundColor: 'rgba(255,30,45,0.06)' }]}
      testID={`broadcast-tpl-${template.type}`}
    >
      <View style={[styles.tplIcon, { borderColor: toneColor + '50', backgroundColor: toneColor + '12' }]}>
        {templateIcon(template.type, 13)}
      </View>
      <Text style={[styles.tplLabel, active && { color: colors.red }]} numberOfLines={1}>{template.label}</Text>
      <Text style={styles.tplHint} numberOfLines={2}>{template.cta_hint}</Text>
      {active && (
        <View style={styles.tplCheck}><Check size={10} color="#fff" strokeWidth={3} /></View>
      )}
    </TouchableOpacity>
  );
}

function VehiclePicker({
  visible, auctions, selectedId, onClose, onPick,
}: {
  visible: boolean; auctions: AuctionItem[]; selectedId: string | null;
  onClose: () => void; onPick: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return auctions;
    return auctions.filter(
      (a) =>
        (a.label || '').toLowerCase().includes(t) ||
        (a.registration_number || '').toLowerCase().includes(t) ||
        (a.city || '').toLowerCase().includes(t),
    );
  }, [q, auctions]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.pickerCard}>
          <View style={styles.pickerHead}>
            <Text style={styles.pickerKicker}>VEHICLE TARGET</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={16} color={colors.textChrome} />
            </TouchableOpacity>
          </View>
          <View style={styles.pickerSearch}>
            <Search size={13} color={colors.textMuted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search make / reg no / city"
              placeholderTextColor={colors.textMuted}
              style={styles.pickerSearchInput}
              autoFocus={Platform.OS !== 'web'}
            />
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(a) => a.auction_id}
            ItemSeparatorComponent={() => <View style={styles.pickerDivider} />}
            ListEmptyComponent={() => (
              <View style={{ padding: 22, alignItems: 'center' }}>
                <Text style={styles.pickerEmpty}>No matching auctions.</Text>
              </View>
            )}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => onPick(item.auction_id)}
                style={styles.pickerRow}
                activeOpacity={0.85}
              >
                <View style={[styles.pickerStatusDot, { backgroundColor: statusColor(item.status) }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.pickerRowTitle} numberOfLines={1}>{item.label}</Text>
                  <Text style={styles.pickerRowSub} numberOfLines={1}>
                    {item.registration_number || '—'} · {item.status.replace(/_/g, ' ').toUpperCase()}
                    {item.city ? ` · ${item.city}` : ''}
                  </Text>
                </View>
                {item.auction_id === selectedId && (
                  <Check size={14} color={colors.red} strokeWidth={3} />
                )}
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

function DealerPicker({
  visible, dealers, selectedIds, onClose, onSubmit,
}: {
  visible: boolean; dealers: Dealer[]; selectedIds: string[];
  onClose: () => void; onSubmit: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>(selectedIds);
  useEffect(() => { setPicked(selectedIds); }, [selectedIds, visible]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return dealers;
    return dealers.filter(
      (d) =>
        (d.full_name || '').toLowerCase().includes(t) ||
        (d.dealership_name || '').toLowerCase().includes(t) ||
        (d.city || '').toLowerCase().includes(t),
    );
  }, [q, dealers]);
  const toggle = (id: string) => {
    setPicked((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.pickerCard}>
          <View style={styles.pickerHead}>
            <Text style={styles.pickerKicker}>SELECT BUYERS · {picked.length} PICKED</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <X size={16} color={colors.textChrome} />
            </TouchableOpacity>
          </View>
          <View style={styles.pickerSearch}>
            <Search size={13} color={colors.textMuted} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search buyership / name / city"
              placeholderTextColor={colors.textMuted}
              style={styles.pickerSearchInput}
            />
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(d) => d.id}
            ItemSeparatorComponent={() => <View style={styles.pickerDivider} />}
            ListEmptyComponent={() => (
              <View style={{ padding: 22, alignItems: 'center' }}>
                <Text style={styles.pickerEmpty}>No buyers match this search.</Text>
              </View>
            )}
            renderItem={({ item }) => {
              const on = picked.includes(item.id);
              return (
                <TouchableOpacity
                  onPress={() => toggle(item.id)}
                  style={styles.pickerRow}
                  activeOpacity={0.85}
                >
                  <View style={[styles.cb, on && styles.cbOn]}>
                    {on && <Check size={11} color="#fff" strokeWidth={3} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerRowTitle} numberOfLines={1}>
                      {item.dealership_name || item.full_name}
                    </Text>
                    <Text style={styles.pickerRowSub} numberOfLines={1}>
                      {item.full_name}{item.city ? ` · ${item.city}` : ''}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            }}
          />
          <View style={styles.pickerFooter}>
            <TouchableOpacity onPress={onClose} style={styles.btnGhost} activeOpacity={0.85}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onSubmit(picked)}
              style={styles.btnPrimary}
              activeOpacity={0.85}
            >
              <Text style={styles.btnPrimaryText}>USE {picked.length}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ConfirmSendModal({
  visible, busy, title, body, audienceLabel, vehicleLabel, regNo, dealerCount,
  onCancel, onConfirm,
}: {
  visible: boolean; busy: boolean; title: string; body: string;
  audienceLabel: string; vehicleLabel: string | null; regNo: string | null;
  dealerCount: number | null; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalOverlay}>
        <View style={[styles.confirmCard]}>
          <View style={styles.confirmHead}>
            <View style={styles.confirmIcon}><AlertCircle size={16} color={colors.red} /></View>
            <Text style={styles.confirmTitle}>Confirm broadcast</Text>
          </View>
          <Text style={styles.confirmCopy}>
            This pushes a notification to every selected dealer immediately. Audit trail is permanent.
          </Text>
          <View style={styles.confirmDivider} />
          <View style={styles.confirmRow}><Text style={styles.confirmK}>HEADLINE</Text><Text style={styles.confirmV} numberOfLines={2}>{title}</Text></View>
          <View style={styles.confirmRow}><Text style={styles.confirmK}>BODY</Text><Text style={styles.confirmV} numberOfLines={3}>{body}</Text></View>
          <View style={styles.confirmRow}><Text style={styles.confirmK}>AUDIENCE</Text>
            <Text style={styles.confirmV}>
              {audienceLabel}{dealerCount !== null ? ` · ${dealerCount} dealer${dealerCount === 1 ? '' : 's'}` : ''}
            </Text>
          </View>
          {vehicleLabel && (
            <View style={styles.confirmRow}><Text style={styles.confirmK}>VEHICLE</Text>
              <Text style={styles.confirmV} numberOfLines={1}>{vehicleLabel}{regNo ? ` (${regNo})` : ''}</Text>
            </View>
          )}
          <View style={styles.confirmActions}>
            <TouchableOpacity onPress={onCancel} disabled={busy} style={styles.btnGhost} activeOpacity={0.85}>
              <Text style={styles.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onConfirm} disabled={busy} style={styles.btnPrimary} activeOpacity={0.85}>
              {busy ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Send size={13} color="#fff" />
                  <Text style={styles.btnPrimaryText}>SEND NOW</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function HistoryRow({ row, last }: { row: RecentBroadcast; last: boolean }) {
  const dt = new Date(row.ts);
  const time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  const date = `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}`;
  const audienceLabel =
    AUDIENCES.find((a) => a.key === row.audience)?.label || row.audience;
  return (
    <View style={[styles.histRow, !last && styles.histRowDivider]}>
      <View style={styles.histIcon}>{templateIcon(row.type, 12)}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.histTitle} numberOfLines={1}>{row.title}</Text>
        <Text style={styles.histSub} numberOfLines={1}>
          {audienceLabel} · {row.recipient_count} sent
          {row.vehicle ? ` · ${row.vehicle.year || ''} ${row.vehicle.make || ''} ${row.vehicle.model || ''}`.trim() : ''}
        </Text>
        <Text style={styles.histMeta} numberOfLines={1}>
          {row.sent_by_name} · {date} {time}
        </Text>
      </View>
      <ChevronRight size={12} color={colors.textMuted} />
    </View>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

function statusColor(s: string) {
  switch (s) {
    case 'live': return colors.success;
    case 'ended_pending_payment': return colors.warning;
    case 'payment_received': return colors.silver;
    case 'vehicle_released': return colors.success;
    case 'upcoming':
    case 'scheduled': return colors.info;
    case 'settled': return colors.silver;
    default: return colors.textMuted;
  }
}

// =====================================================================
// STYLES
// =====================================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 16, paddingBottom: 60 },
  bootLoader: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  /* SECTION LABEL  */
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22, marginBottom: 9 },
  sectionN: {
    color: colors.textMuted, fontSize: 9, fontWeight: '900',
    letterSpacing: 1.2, paddingHorizontal: 5, paddingVertical: 2,
    borderRadius: 3, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.bgCard, fontVariant: ['tabular-nums'],
  },
  sectionLabel: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, flex: 1 },
  sectionHint: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.0 },

  /* TEMPLATE GRID */
  tplGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tplCard: {
    width: '48%', padding: 11, borderRadius: 8,
    backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border,
    position: 'relative',
  },
  tplIcon: {
    width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, marginBottom: 7,
  },
  tplLabel: { color: colors.textPrimary, fontSize: 12, fontWeight: '900', letterSpacing: 0.3 },
  tplHint: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 3, lineHeight: 13 },
  tplCheck: {
    position: 'absolute', top: 7, right: 7,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center',
  },

  /* FIELD BUTTON (vehicle / dealer pickers) */
  fieldBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 11,
    backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderRadius: 8,
  },
  fieldBtnRequired: { borderColor: 'rgba(245,158,11,0.55)', backgroundColor: 'rgba(245,158,11,0.05)' },
  fieldBtnIcon: {
    width: 28, height: 28, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  fieldBtnTitle: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '800' },
  fieldBtnPlaceholder: { color: colors.textChrome, fontSize: 12.5, fontWeight: '700' },
  fieldBtnSub: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2 },

  /* AUDIENCE LIST */
  audienceList: { gap: 7 },
  audItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11,
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: 8,
  },
  audItemActive: { borderColor: 'rgba(255,30,45,0.55)', backgroundColor: 'rgba(255,30,45,0.05)' },
  audItemDisabled: { opacity: 0.45 },
  audIcon: {
    width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
  },
  audLabel: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '800' },
  audSub: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2 },
  radio: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioActive: { borderColor: colors.red },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },

  /* COMPOSER */
  smallLabel: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.2, marginBottom: 6, marginTop: 4 },
  hint: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  input: {
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md,
    paddingHorizontal: 13, paddingVertical: 11, color: colors.textPrimary,
    fontSize: 13.5, fontWeight: '700',
  },
  textarea: { minHeight: 100, paddingTop: 11 },

  /* PREVIEW */
  previewBox: {
    flexDirection: 'row', gap: 11, padding: 13, borderRadius: 10,
    backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border,
  },
  previewIcon: {
    width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,30,45,0.10)', borderWidth: 1, borderColor: 'rgba(255,30,45,0.40)',
  },
  previewTitle: { color: colors.textPrimary, fontSize: 13.5, fontWeight: '900' },
  previewBody: { color: colors.textChrome, fontSize: 11.5, marginTop: 4, lineHeight: 16, fontWeight: '600' },
  previewMeta: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 0.8, marginTop: 6 },

  /* SEND BUTTON */
  sendBtn: {
    marginTop: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 15, backgroundColor: colors.red, borderRadius: 10,
    shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 7,
  },
  sendBtnDisabled: { backgroundColor: '#3a1418', shadowOpacity: 0 },
  sendBtnText: { color: '#fff', fontSize: 12.5, fontWeight: '900', letterSpacing: 1.4 },
  sendHint: { color: colors.textMuted, fontSize: 10, fontWeight: '700', marginTop: 6, textAlign: 'center', letterSpacing: 0.4 },

  /* HISTORY */
  historyHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 26, marginBottom: 8 },
  historyTitle: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 1.4, flex: 1 },
  historyMeta: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  historyEmpty: { padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 8, borderStyle: 'dashed', alignItems: 'center' },
  historyEmptyText: { color: colors.textMuted, fontSize: 10.5, fontWeight: '700' },
  historyList: { backgroundColor: colors.bgCard, borderRadius: 8, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  histRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 11, paddingVertical: 10 },
  histRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  histIcon: { width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  histTitle: { color: colors.textPrimary, fontSize: 12, fontWeight: '800' },
  histSub: { color: colors.textChrome, fontSize: 10.5, fontWeight: '600', marginTop: 1 },
  histMeta: { color: colors.textMuted, fontSize: 9.5, fontWeight: '700', marginTop: 1, fontVariant: ['tabular-nums'] },

  /* MODALS */
  modalOverlay: { flex: 1, backgroundColor: colors.bgOverlay, justifyContent: 'flex-end' },
  pickerCard: {
    backgroundColor: colors.bgElevated, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderColor: colors.border, borderWidth: 1, maxHeight: '80%',
  },
  pickerHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pickerKicker: { color: colors.textChrome, fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  pickerSearch: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pickerSearchInput: { flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  pickerDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  pickerStatusDot: { width: 7, height: 7, borderRadius: 4 },
  pickerRowTitle: { color: colors.textPrimary, fontSize: 12.5, fontWeight: '800' },
  pickerRowSub: { color: colors.textMuted, fontSize: 10, fontWeight: '600', marginTop: 2 },
  pickerEmpty: { color: colors.textMuted, fontSize: 11.5, fontWeight: '700' },

  cb: { width: 18, height: 18, borderRadius: 4, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  cbOn: { borderColor: colors.red, backgroundColor: colors.red },

  pickerFooter: {
    flexDirection: 'row', gap: 10, padding: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  btnGhost: {
    flex: 1, paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgCard,
  },
  btnGhostText: { color: colors.textChrome, fontSize: 12, fontWeight: '900', letterSpacing: 0.8 },
  btnPrimary: {
    flex: 1.4, paddingVertical: 12, alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, backgroundColor: colors.red, flexDirection: 'row', gap: 7,
  },
  btnPrimaryText: { color: '#fff', fontSize: 12, fontWeight: '900', letterSpacing: 1.2 },

  /* CONFIRM MODAL */
  confirmCard: {
    backgroundColor: colors.bgElevated, borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderColor: colors.border, borderWidth: 1, padding: 18,
  },
  confirmHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  confirmIcon: { width: 30, height: 30, borderRadius: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,30,45,0.10)', borderWidth: 1, borderColor: 'rgba(255,30,45,0.45)' },
  confirmTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '900', letterSpacing: 0.2 },
  confirmCopy: { color: colors.textChrome, fontSize: 11.5, fontWeight: '600', lineHeight: 15 },
  confirmDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 12 },
  confirmRow: { flexDirection: 'row', gap: 12, marginBottom: 9 },
  confirmK: { width: 80, color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1, paddingTop: 2 },
  confirmV: { flex: 1, color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
});
