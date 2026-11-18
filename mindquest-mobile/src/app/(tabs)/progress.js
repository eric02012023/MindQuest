/**
 * File: src/app/(tabs)/progress.js
 * Purpose: My Progress (/student/progress): per subject, the current level,
 *          modules opened, the Pre- and Post-Assessment, and every assessment.
 */
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { formatDate, percent } from '../../lib/format';
import { COLORS } from '../../lib/config';
import { Badge, Card, Empty, ListItem, Muted, PageView, ProgressBar, Row, levelTone } from '../../components/ui';

export default function ProgressScreen() {
  const router = useRouter();
  const page = usePage('/progress');
  const d = page.data || {};
  const o = d.overview || {};

  return (
    <PageView page={page}>
      <View style={styles.tiles}>
        <Tile label="Average" value={o.overallAverage === null || o.overallAverage === undefined ? '—' : percent(o.overallAverage)} />
        <Tile label="Assessments" value={o.assessmentsTaken || 0} />
        <Tile label="Modules" value={`${o.modulesOpened || 0}/${o.modulesTotal || 0}`} />
      </View>

      {(d.subjects || []).length ? d.subjects.map((s) => (
        <Card key={s.subjectId} title={s.subjectName} right={s.currentLevel ? <Badge text={s.currentLevel} tone={levelTone(s.currentLevel)} /> : null}>
          {s.viewOnly ? <Muted>View only — the month is over.</Muted> : null}
          <Muted>Modules opened {s.modulesOpened} of {s.modulesTotal}</Muted>
          <ProgressBar percent={s.modulesTotal ? (s.modulesOpened / s.modulesTotal) * 100 : 0} />
          <Row label="Pre-Assessment" value={s.pre ? `${s.pre.score}/${s.pre.totalPoints} · ${percent(s.pre.percentage)} · ${s.pre.level}` : 'Not taken'} />
          <Row label="Post-Assessment" value={s.post ? `${s.post.score}/${s.post.totalPoints} · ${percent(s.post.percentage)} · ${s.post.level}` : 'Not taken'} />
          <Row label="Activities done" value={`${s.activitiesDone} of ${s.activitiesTotal}`} />
          {s.violations ? <Row label="Anti-cheat warnings" value={String(s.violations)} /> : null}
          {s.assessments.length ? s.assessments.map((a, index) => (
            <ListItem
              key={`${a.title}-${index}`}
              title={a.title}
              subtitle={[a.kind, a.module, a.takenAt ? formatDate(a.takenAt) : 'Not taken yet'].filter(Boolean).join(' · ')}
              right={a.percentage !== null && a.percentage !== undefined ? <Badge text={percent(a.percentage)} tone={levelTone(a.level)} /> : null}
              onPress={a.path ? () => router.push(a.path) : undefined}
            />
          )) : <Empty>No assessments yet.</Empty>}
        </Card>
      )) : <Card><Empty>No subjects yet.</Empty></Card>}
    </PageView>
  );
}

function Tile({ label, value }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: COLORS.border, padding: 12, alignItems: 'center' },
  tileValue: { fontSize: 20, fontWeight: '800', color: COLORS.greenDark },
  tileLabel: { fontSize: 12, color: COLORS.muted, marginTop: 2 }
});
