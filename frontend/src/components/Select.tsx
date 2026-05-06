import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, ScrollView,
} from 'react-native';
import { ChevronDown, Check } from 'lucide-react-native';
import { colors, radii } from '../theme';

type Option = { label: string; value: string | number };

type Props = {
  value?: string | number | null;
  onChange: (v: string | number) => void;
  options: Option[] | (string | number)[];
  placeholder?: string;
  testID?: string;
  disabled?: boolean;
  modalTitle?: string;
};

function normaliseOption(o: Option | string | number): Option {
  if (typeof o === 'string' || typeof o === 'number') return { label: String(o), value: o };
  return o;
}

export function Select({ value, onChange, options, placeholder, testID, disabled, modalTitle }: Props) {
  const [open, setOpen] = useState(false);
  const opts = options.map(normaliseOption);
  const selected = opts.find((o) => o.value === value);

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.85}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[styles.field, disabled && styles.fieldDisabled]}
        testID={testID}
      >
        <Text style={[styles.fieldText, !selected && styles.placeholder]}>
          {selected?.label ?? placeholder ?? 'Select…'}
        </Text>
        <ChevronDown size={16} color={colors.textMuted} />
      </TouchableOpacity>

      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            {modalTitle && <Text style={styles.sheetTitle}>{modalTitle}</Text>}
            <View style={styles.handle} />
            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              {opts.map((o) => {
                const isActive = o.value === value;
                return (
                  <TouchableOpacity
                    key={String(o.value)}
                    style={[styles.row, isActive && styles.rowActive]}
                    onPress={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                  >
                    <Text style={[styles.rowText, isActive && styles.rowTextActive]}>{o.label}</Text>
                    {isActive && <Check size={16} color={colors.red} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1,
    borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 14,
  },
  fieldDisabled: { opacity: 0.5 },
  fieldText: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  placeholder: { color: colors.textMuted, fontWeight: '500' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bgElevated, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32, maxHeight: '70%',
    borderTopWidth: 1, borderColor: colors.border,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 12 },
  sheetTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: '800', textAlign: 'center', marginTop: 6 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 12,
    borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowActive: { backgroundColor: 'rgba(185,28,28,0.06)' },
  rowText: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  rowTextActive: { color: colors.red, fontWeight: '800' },
});
