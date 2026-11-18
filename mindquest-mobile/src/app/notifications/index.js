/**
 * File: src/app/notifications/index.js
 * Purpose: Notifications (/student/notifications): tutors' answers to the
 *          student's requests, then every update. Mark one read, mark all
 *          read, archive one, or open the page it is about.
 */
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { postAction } from '../../lib/api';
import { followAnswer, goTo } from '../../lib/navigation';
import { formatDateTime } from '../../lib/format';
import { COLORS } from '../../lib/config';
import { Avatar, Badge, Body, Button, Card, Empty, Muted, PageView } from '../../components/ui';
import { AlertRow } from '../../components/AlertRow';

const HERE = '/notifications';

export default function NotificationsScreen() {
  const router = useRouter();
  const page = usePage(HERE);
  const d = page.data || {};

  const act = async (path) => {
    try {
      const answer = await postAction(path, {}, { from: HERE });
      await followAnswer(router, answer, { current: HERE, reload: page.reload, onFlash: page.setFlash });
    } catch (error) {
      page.setFlash({ type: 'error', message: error.message });
    }
  };

  // Opening one marks it read first, as the website's bell does.
  const open = async (alert) => {
    try { if (!alert.isRead) await postAction(`/alerts/${alert.id}/read`, {}, { from: HERE }); } catch (_error) { /* still open it */ }
    goTo(router, alert.path);
  };

  return (
    <PageView page={page}>
      <View style={styles.actions}>
        <Button title="Mark all read" icon="checkmark-done-outline" small onPress={() => act('/notifications/mark-all-read')} />
        <Button title="Archived" tone="secondary" small onPress={() => router.push('/notifications/archive')} />
        <Button title="History" tone="secondary" small onPress={() => router.push('/notifications/history')} />
      </View>

      <Card title="Tutor answers">
        {(d.answers || []).length ? d.answers.map((a) => (
          <View key={a.id} style={styles.answer}>
            <Avatar path={a.tutorImagePath} name={a.tutorName} size={40} />
            <View style={styles.flex}>
              <Body>
                <Body style={styles.bold}>{a.tutorName}</Body> {a.accepted ? 'accepted' : 'cancelled'} your request for {a.subjectName}
                {a.preferredDays || a.timeSlot ? ` (${[a.preferredDays, a.timeSlot].filter(Boolean).join(', ')})` : ''}.
              </Body>
              <Muted>{formatDateTime(a.at)}</Muted>
              <View style={styles.rowActions}>
                <Badge text={a.accepted ? 'Accepted' : 'Cancelled'} tone={a.accepted ? 'green' : 'red'} />
                <Button title="Mark read" tone="secondary" small onPress={() => act(`/notifications/${a.id}/read`)} />
              </View>
            </View>
          </View>
        )) : <Empty>No new answers from tutors.</Empty>}
      </Card>

      <Card title="Updates">
        {(d.updates || []).length ? d.updates.map((alert) => (
          <AlertRow
            key={alert.id}
            alert={alert}
            onOpen={open}
            onRead={(a) => act(`/alerts/${a.id}/read`)}
            onArchive={(a) => act(`/alerts/${a.id}/archive`)}
          />
        )) : <Empty>No notifications.</Empty>}
      </Card>
    </PageView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  answer: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }
});
