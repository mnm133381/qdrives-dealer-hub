/**
 * Operator reason modal — used for every audited mutation that requires
 * a mandatory reason (pause, cancel, force-close, bid cancel).
 */
import React, { useState } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, Modal,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { X, AlertOctagon } from 'lucide-react-native';
import { colors, radii } from '../theme';

const MIN_REASON_LEN = 5;

export function ReasonModal({
  visible, title, kicker = 'AUDITED ACTION', cta = 'Confirm', danger = true, busy = false,
  onClose, onSubmit,
}: {
  visible: boolean; title: string; kicker?: string; cta?: string; danger?: boolean; busy?: boolean;
  onClose: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  // Reset reason whenever the modal toggles open — prevents stale text leaking
  // between two different audited actions in the same screen.
  React.useEffect(() => { if (visible) setReason(''); }, [visible]);
  const trimmed = reason.trim();
  const valid = trimmed.length >= MIN_REASON_LEN;
  const remaining = Math.max(0, MIN_REASON_LEN - trimmed.length);
  const submit = () => {
    if (!valid) return;
    onSubmit(trimmed);
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ width: '100%' }}>
          <View style={[styles.card, danger && styles.cardDanger]}>
            <View style={styles.head}>
              <View style={[styles.icon, danger && styles.iconDanger]}>
                <AlertOctagon size={16} color={danger ? colors.red : colors.warning} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.kicker}>{kicker}</Text>
                <Text style={styles.title}>{title}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.close} testID="reason-modal-close">
                <X size={16} color={colors.textChrome} />
              </TouchableOpacity>
            </View>
            <Text style={styles.note}>This action will be permanently recorded in the audit log.</Text>
            <Text style={styles.label}>REASON · MANDATORY</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Detailed reason for the audit trail…"
              placeholderTextColor={colors.textMuted}
              multiline
              style={styles.input}
              testID="reason-modal-input"
              autoFocus
            />
            <Text style={[styles.helper, valid && styles.helperOk]} testID="reason-modal-helper">
              {valid
                ? `${trimmed.length} chars · audit-ready`
                : `${remaining} more char${remaining === 1 ? '' : 's'} required (min ${MIN_REASON_LEN})`}
            </Text>
            <TouchableOpacity
              disabled={!valid || busy}
              onPress={submit}
              style={[styles.cta, danger && styles.ctaDanger, (!valid || busy) && { opacity: 0.4 }]}
              testID="reason-modal-submit"
            >
              <Text style={styles.ctaText}>{busy ? 'Processing…' : cta}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  card: { backgroundColor: colors.bgElevated, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, borderTopWidth: 1.5, borderColor: 'rgba(245,158,11,0.4)' },
  cardDanger: { borderColor: 'rgba(185,28,28,0.5)' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,158,11,0.10)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)' },
  iconDanger: { backgroundColor: 'rgba(185,28,28,0.10)', borderColor: 'rgba(185,28,28,0.4)' },
  kicker: { color: colors.red, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.4 },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '800', marginTop: 1 },
  close: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  note: { color: colors.textChrome, fontSize: 11.5, marginBottom: 14, lineHeight: 16 },
  label: { color: colors.textMuted, fontSize: 9.5, fontWeight: '900', letterSpacing: 1.2, marginBottom: 6 },
  input: { color: colors.textPrimary, fontSize: 13, fontWeight: '500', minHeight: 70, padding: 12, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, textAlignVertical: 'top', marginBottom: 8 },
  helper: { color: colors.warning, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.4, marginBottom: 12 },
  helperOk: { color: colors.success },
  cta: { paddingVertical: 13, borderRadius: radii.md, backgroundColor: colors.warning, alignItems: 'center' },
  ctaDanger: { backgroundColor: colors.red },
  ctaText: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
});
