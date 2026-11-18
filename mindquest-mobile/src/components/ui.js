/**
 * File: src/components/ui.js
 * Purpose: The building blocks every screen is made of, so all screens look
 *          and behave alike: a scrolling page with pull-to-refresh, cards,
 *          buttons, badges, the flash banner, and the Loading / Error states.
 */
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../lib/config';
import { imageUrl } from '../lib/api';

/**
 * A page loaded with usePage(): shows Loading, or the error with Retry, or
 * the content in a pull-to-refresh scroll view with the flash on top.
 */
export function PageView({ page, children, footer }) {
  if (page.loading && !page.data) return <LoadingView />;
  if (page.error && !page.data) return <ErrorView message={page.error} onRetry={page.retry} />;
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      refreshControl={<RefreshControl refreshing={page.refreshing} onRefresh={page.refresh} colors={[COLORS.green]} />}
      keyboardShouldPersistTaps="handled"
    >
      <FlashBanner flash={page.flash} onClose={() => page.setFlash(null)} />
      {page.data ? children : null}
      {footer}
    </ScrollView>
  );
}

export function LoadingView({ label = 'Loading…' }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={COLORS.green} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function ErrorView({ message, onRetry }) {
  return (
    <View style={styles.center}>
      <Ionicons name="cloud-offline-outline" size={44} color={COLORS.muted} />
      <Text style={[styles.body, styles.centerText]}>{message || 'Something went wrong.'}</Text>
      {onRetry ? <Button title="Retry" onPress={onRetry} /> : null}
    </View>
  );
}

const FLASH_TONES = {
  success: { bg: COLORS.greenSoft, fg: COLORS.greenDark, icon: 'checkmark-circle' },
  error: { bg: COLORS.dangerSoft, fg: COLORS.danger, icon: 'alert-circle' },
  warning: { bg: COLORS.warningSoft, fg: COLORS.warning, icon: 'warning' },
  info: { bg: COLORS.infoSoft, fg: COLORS.info, icon: 'information-circle' }
};

/** The website's flash message, at the top of the screen. */
export function FlashBanner({ flash, onClose }) {
  if (!flash || !flash.message) return null;
  const tone = FLASH_TONES[flash.type] || FLASH_TONES.info;
  return (
    <View style={[styles.flash, { backgroundColor: tone.bg }]} accessibilityRole="alert">
      <Ionicons name={tone.icon} size={20} color={tone.fg} />
      <Text style={[styles.flashText, { color: tone.fg }]}>{flash.message}</Text>
      {onClose ? (
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close message">
          <Ionicons name="close" size={18} color={tone.fg} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A note in a coloured box (a locked gate, a month note). */
export function Notice({ tone = 'info', children, icon }) {
  const t = FLASH_TONES[tone] || FLASH_TONES.info;
  return (
    <View style={[styles.flash, { backgroundColor: t.bg }]}>
      <Ionicons name={icon || t.icon} size={20} color={t.fg} />
      <Text style={[styles.flashText, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

export function Card({ title, right, children, style }) {
  return (
    <View style={[styles.card, style]}>
      {title || right ? (
        <View style={styles.cardHead}>
          {title ? <Text style={styles.cardTitle}>{title}</Text> : <View />}
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const BUTTON_TONES = {
  primary: { bg: COLORS.green, fg: '#fff', border: COLORS.green },
  dark: { bg: COLORS.greenDark, fg: '#fff', border: COLORS.greenDark },
  secondary: { bg: '#fff', fg: COLORS.greenDark, border: COLORS.border },
  danger: { bg: '#fff', fg: COLORS.danger, border: COLORS.danger }
};

/** A button that shows a spinner while its async action runs (and cannot be pressed twice). */
export function Button({ title, onPress, tone = 'primary', icon, disabled, small, style }) {
  const [busy, setBusy] = useState(false);
  const t = BUTTON_TONES[tone] || BUTTON_TONES.primary;
  const off = disabled || busy;
  const press = async () => {
    if (off || !onPress) return;
    setBusy(true);
    try { await onPress(); } finally { setBusy(false); }
  };
  return (
    <Pressable
      onPress={press}
      disabled={off}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: t.bg, borderColor: t.border, opacity: off ? 0.55 : pressed ? 0.85 : 1 },
        style
      ]}
    >
      {busy ? <ActivityIndicator color={t.fg} size="small" /> : icon ? <Ionicons name={icon} size={small ? 16 : 18} color={t.fg} /> : null}
      <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: t.fg }]}>{title}</Text>
    </Pressable>
  );
}

const BADGE_TONES = {
  green: [COLORS.greenSoft, COLORS.greenDark],
  red: [COLORS.dangerSoft, COLORS.danger],
  amber: [COLORS.warningSoft, COLORS.warning],
  blue: [COLORS.infoSoft, COLORS.info],
  grey: ['#eef1ee', COLORS.muted]
};

export function Badge({ text, tone = 'grey' }) {
  const [bg, fg] = BADGE_TONES[tone] || BADGE_TONES.grey;
  if (!text) return null;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{text}</Text>
    </View>
  );
}

/** The colour of a level: Beginner red, Intermediate amber, Advance green. */
export function levelTone(level) {
  const l = String(level || '').toLowerCase();
  if (l.startsWith('adv')) return 'green';
  if (l.startsWith('inter')) return 'amber';
  if (l.startsWith('begin')) return 'red';
  return 'grey';
}

/** "Label ........ value" on one line. */
export function Row({ label, value, strong }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong]}>{value === null || value === undefined || value === '' ? '—' : value}</Text>
    </View>
  );
}

/** A tappable line in a list, with a chevron. */
export function ListItem({ title, subtitle, right, onPress, icon }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.listItem, pressed && onPress && styles.pressed]}>
      {icon ? <Ionicons name={icon} size={22} color={COLORS.green} style={styles.listIcon} /> : null}
      <View style={styles.flex}>
        <Text style={styles.listTitle}>{title}</Text>
        {subtitle ? <Text style={styles.listSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={COLORS.muted} /> : null}
    </Pressable>
  );
}

export function Empty({ children }) {
  return <Text style={styles.empty}>{children}</Text>;
}

export function Muted({ children, style }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Body({ children, style }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function Heading({ children }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function ProgressBar({ percent }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${p}%` }]} />
    </View>
  );
}

/** A round photo (a server path, or a local `localUri` just picked), or the initials. */
export function Avatar({ path, localUri, name, size = 44 }) {
  const uri = localUri || imageUrl(path);
  const initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (uri) return <Image source={{ uri }} style={[round, styles.avatarImage]} accessibilityIgnoresInvertColors />;
  return (
    <View style={[round, styles.avatarFallback]}>
      <Text style={[styles.avatarText, { fontSize: size * 0.38 }]}>{initials || '?'}</Text>
    </View>
  );
}

/** A segmented switch (the history tabs on Billing). */
export function Segments({ items, value, onChange }) {
  return (
    <View style={styles.segments}>
      {items.map((item) => (
        <Pressable
          key={item.value}
          onPress={() => onChange(item.value)}
          style={[styles.segment, value === item.value && styles.segmentOn]}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === item.value }}
        >
          <Text style={[styles.segmentText, value === item.value && styles.segmentTextOn]}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.background },
  pageContent: { padding: 16, paddingBottom: 40, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12, backgroundColor: COLORS.background },
  centerText: { textAlign: 'center' },
  flex: { flex: 1 },
  muted: { color: COLORS.muted, fontSize: 13, lineHeight: 18 },
  body: { color: COLORS.text, fontSize: 15, lineHeight: 22 },
  strong: { fontWeight: '700' },
  heading: { color: COLORS.greenDark, fontSize: 20, fontWeight: '800' },
  flash: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 10 },
  flashText: { flex: 1, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: COLORS.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: COLORS.border, gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { color: COLORS.greenDark, fontSize: 16, fontWeight: '800', flexShrink: 1 },
  button: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1 },
  buttonSmall: { paddingVertical: 7, paddingHorizontal: 12 },
  buttonText: { fontSize: 15, fontWeight: '700' },
  buttonTextSmall: { fontSize: 13 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  rowLabel: { color: COLORS.muted, fontSize: 14, flexShrink: 0 },
  rowValue: { color: COLORS.text, fontSize: 14, flexShrink: 1, textAlign: 'right' },
  listItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  listIcon: { width: 24 },
  listTitle: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  listSubtitle: { color: COLORS.muted, fontSize: 13, marginTop: 2 },
  pressed: { opacity: 0.7 },
  empty: { color: COLORS.muted, fontSize: 14, fontStyle: 'italic', paddingVertical: 6 },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: '#e3ebe4', overflow: 'hidden' },
  progressFill: { height: 8, backgroundColor: COLORS.green },
  avatarImage: { backgroundColor: '#e3ebe4' },
  avatarFallback: { backgroundColor: COLORS.greenSoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.greenDark, fontWeight: '800' },
  segments: { flexDirection: 'row', backgroundColor: '#e8eee8', borderRadius: 10, padding: 3 },
  segment: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 },
  segmentOn: { backgroundColor: '#fff' },
  segmentText: { color: COLORS.muted, fontWeight: '600', fontSize: 13 },
  segmentTextOn: { color: COLORS.greenDark }
});
