/**
 * File: src/app/(tabs)/index.js
 * Purpose: Home — the website's Student Dashboard (/student): a welcome, the
 *          student's subjects, their tutors, attendance and latest statement.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { formatDate, money } from '../../lib/format';
import { COLORS } from '../../lib/config';
import { Avatar, Badge, Card, Empty, ListItem, Muted, PageView, Row } from '../../components/ui';

export default function HomeScreen() {
  const router = useRouter();
  const page = usePage('/');
  const d = page.data || {};
  const attendance = d.attendance || {};

  return (
    <PageView page={page}>
      <View style={styles.hello}>
        <Avatar path={d.imagePath} name={d.firstName} size={52} />
        <View style={styles.flex}>
          <Text style={styles.helloTitle}>Hello, {d.firstName || 'student'}!</Text>
          <Muted>Welcome to MindQuest.</Muted>
        </View>
      </View>

      <Card title="My Subjects">
        {(d.subjects || []).length ? (d.subjects || []).map((s) => (
          <ListItem
            key={s.subjectId}
            icon="book-outline"
            title={s.subjectName}
            subtitle={s.tutorName ? `${s.tutorName} · ${[s.preferredDays, s.timeSlot].filter(Boolean).join(', ')}` : 'No tutor yet'}
            right={s.viewOnly ? <Badge text="View only" /> : null}
            onPress={() => router.push(`/subjects/${s.subjectId}`)}
          />
        )) : <Empty>You are not enrolled in a subject yet.</Empty>}
      </Card>

      <Card title="My Tutors">
        {(d.tutors || []).length ? (d.tutors || []).map((t) => (
          <ListItem
            key={t.id}
            icon="person-outline"
            title={t.name}
            subtitle={t.subjects.join(', ')}
            onPress={() => router.push(`/tutors/${t.id}`)}
          />
        )) : <Empty>No tutor assigned yet.</Empty>}
      </Card>

      <Card title="Attendance">
        <View style={styles.tiles}>
          <Tile label="Present" value={attendance.present} color={COLORS.green} />
          <Tile label="Late" value={attendance.late} color={COLORS.warning} />
          <Tile label="Absent" value={attendance.absent} color={COLORS.danger} />
          <Tile label="Excused" value={attendance.excused} color={COLORS.info} />
        </View>
      </Card>

      <Card title="Latest Statement">
        {d.latestSoa ? (
          <>
            <Row label="Date" value={formatDate(d.latestSoa.statementDate)} />
            <Row label="Full bill" value={money(d.latestSoa.fullBill)} />
            <Row label="For settlement" value={money(d.latestSoa.forSettlement)} strong />
          </>
        ) : <Empty>No statement yet.</Empty>}
      </Card>
    </PageView>
  );
}

function Tile({ label, value, color }) {
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileValue, { color }]}>{Number(value || 0)}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hello: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  helloTitle: { fontSize: 22, fontWeight: '800', color: COLORS.greenDark },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, alignItems: 'center', paddingVertical: 8, backgroundColor: COLORS.background, borderRadius: 10 },
  tileValue: { fontSize: 22, fontWeight: '800' },
  tileLabel: { fontSize: 12, color: COLORS.muted }
});
