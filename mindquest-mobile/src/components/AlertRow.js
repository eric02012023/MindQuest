/**
 * File: src/components/AlertRow.js
 * Purpose: One notification (payment reminder, a tutor's note, a new result…)
 *          with its actions: open it, mark it read, archive or recover it.
 */
import { StyleSheet, View } from 'react-native';
import { COLORS } from '../lib/config';
import { formatDateTime } from '../lib/format';
import { Badge, Body, Button, Muted } from './ui';

export function AlertRow({ alert, onOpen, onRead, onArchive, onRecover }) {
  return (
    <View style={[styles.row, !alert.isRead && styles.unread]}>
      <View style={styles.head}>
        <Body style={styles.title}>{alert.title}</Body>
        {!alert.isRead ? <Badge text="New" tone="green" /> : null}
      </View>
      {alert.message ? <Body>{alert.message}</Body> : null}
      <Muted>{formatDateTime(alert.createdAt)}</Muted>
      <View style={styles.actions}>
        {alert.path && onOpen ? <Button title="Open" small onPress={() => onOpen(alert)} /> : null}
        {!alert.isRead && onRead ? <Button title="Mark read" tone="secondary" small onPress={() => onRead(alert)} /> : null}
        {onArchive ? <Button title="Archive" tone="secondary" small onPress={() => onArchive(alert)} /> : null}
        {onRecover ? <Button title="Recover" tone="secondary" small onPress={() => onRecover(alert)} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, paddingHorizontal: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border, gap: 4, borderRadius: 8 },
  unread: { backgroundColor: COLORS.greenSoft },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontWeight: '700', flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }
});
