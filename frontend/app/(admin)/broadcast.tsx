import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Megaphone, Send, Users } from 'lucide-react-native';
import { colors, radii } from '../../src/theme';
import { api } from '../../src/api';
import { useToast } from '../../src/toast';
import { AdminHeader } from '../../src/components/AdminHeader';

const AUDIENCES = [
  { key: 'verified', label: 'Verified dealers', sub: 'Active + approved (recommended)' },
  { key: 'active', label: 'Non-suspended', sub: 'Including pending verification' },
  { key: 'all', label: 'All dealers', sub: 'Includes suspended (use carefully)' },
];

export default function AdminBroadcast() {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('verified');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (title.trim().length < 3) { toast.show('Add a clearer headline', 'error'); return; }
    if (body.trim().length < 5) { toast.show('Body is too short', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.adminBroadcast({ title: title.trim(), body: body.trim(), audience });
      toast.show(`Sent to ${(r as any).sent} dealer${(r as any).sent === 1 ? '' : 's'}`, 'success');
      setTitle(''); setBody('');
    } catch (e: any) { toast.show(e.message || 'Broadcast failed', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1, backgroundColor: colors.bg }}>
      <AdminHeader kicker="Broadcast notification" title="Reach your dealer network" sub="Sends an instant push to selected audience plus a notification to each dealer's inbox." />
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">

        <Text style={styles.label}>AUDIENCE</Text>
        <View style={styles.audienceList}>
          {AUDIENCES.map((a) => (
            <TouchableOpacity key={a.key} onPress={() => setAudience(a.key)} style={[styles.audItem, audience === a.key && styles.audItemActive]}>
              <View style={styles.audIcon}><Users size={14} color={audience === a.key ? colors.red : colors.textChrome} /></View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.audLabel, audience === a.key && { color: colors.red }]}>{a.label}</Text>
                <Text style={styles.audSub}>{a.sub}</Text>
              </View>
              <View style={[styles.radio, audience === a.key && styles.radioActive]}>
                {audience === a.key && <View style={styles.radioDot} />}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>HEADLINE</Text>
        <TextInput
          value={title} onChangeText={setTitle}
          placeholder="e.g. Premium SUVs going live in 30 minutes"
          placeholderTextColor={colors.textMuted}
          style={styles.input} maxLength={80}
        />
        <Text style={styles.hint}>{title.length}/80 · keep punchy and time-sensitive</Text>

        <Text style={styles.label}>BODY</Text>
        <TextInput
          value={body} onChangeText={setBody}
          placeholder="e.g. 12 fresh inspected listings entering live auction at 6 PM. Set your watchlist now."
          placeholderTextColor={colors.textMuted}
          style={[styles.input, styles.textarea]}
          multiline numberOfLines={5} textAlignVertical="top"
          maxLength={240}
        />
        <Text style={styles.hint}>{body.length}/240 characters</Text>

        {/* Preview card */}
        <View style={styles.previewCard}>
          <Text style={styles.previewKicker}>PREVIEW · PUSH NOTIFICATION</Text>
          <View style={styles.previewBox}>
            <View style={styles.previewIcon}><Megaphone size={14} color={colors.red} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.previewTitle} numberOfLines={1}>{title || 'Your headline appears here'}</Text>
              <Text style={styles.previewBody} numberOfLines={3}>{body || 'Your message body appears here.'}</Text>
            </View>
          </View>
        </View>

        <TouchableOpacity onPress={send} disabled={busy} style={styles.sendBtn}>
          {busy ? <ActivityIndicator color="#fff" /> : (
            <>
              <Send size={16} color="#fff" />
              <Text style={styles.sendBtnText}>SEND BROADCAST</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.textMuted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginTop: 14, marginBottom: 8 },
  hint: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  audienceList: { gap: 8 },
  audItem: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md },
  audItemActive: { borderColor: colors.red, backgroundColor: 'rgba(185,28,28,0.05)' },
  audIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  audLabel: { color: colors.textPrimary, fontSize: 13, fontWeight: '800' },
  audSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  radioActive: { borderColor: colors.red },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.red },
  input: { backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 12, color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  textarea: { minHeight: 110, paddingTop: 12 },
  previewCard: { marginTop: 22 },
  previewKicker: { color: colors.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 1.4, marginBottom: 8 },
  previewBox: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: radii.md, backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.border },
  previewIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(185,28,28,0.10)', borderWidth: 1, borderColor: 'rgba(185,28,28,0.4)' },
  previewTitle: { color: colors.textPrimary, fontSize: 13, fontWeight: '800' },
  previewBody: { color: colors.textChrome, fontSize: 11, marginTop: 3, lineHeight: 16 },
  sendBtn: { marginTop: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 16, backgroundColor: colors.red, borderRadius: radii.md, shadowColor: colors.red, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 16, elevation: 8 },
  sendBtnText: { color: '#fff', fontSize: 13, fontWeight: '900', letterSpacing: 1.2 },
});
