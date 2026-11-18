/**
 * File: src/app/subjects/[id]/index.js
 * Purpose: One subject (/student/subjects/:id), in the website's order:
 *
 *   tutor and schedule -> month notes -> the Pre-Assessment (or WHY it is
 *   locked: no grade level, no modules, the down payment, no handout yet) ->
 *   the modules, or the learning path -> the Post-Assessment with Before/After
 *   -> the files shared before modules existed -> attendance.
 *
 * Every lock decision is made on the server (lib/mobileSerializers.js reads
 * the same values the website's template reads); this screen only shows it.
 */
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { usePage } from '../../../lib/usePage';
import { openProtectedFile } from '../../../lib/api';
import { formatDate, percent } from '../../../lib/format';
import { COLORS } from '../../../lib/config';
import { Avatar, Badge, Body, Button, Card, Empty, ListItem, Muted, Notice, PageView, Row, levelTone } from '../../../components/ui';

const STATUS_LABELS = {
  locked: 'Locked', open: 'Open', in_progress: 'In progress', passed: 'Passed', removed: 'Removed', preparing: 'Being prepared'
};

export default function SubjectScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const page = usePage(`/subjects/${id}`);
  const d = page.data || {};
  const s = d.subject || {};

  const openFile = (file) => openProtectedFile(file.fileUrl, `${file.title || 'file'}`.replace(/\s+/g, '-'))
    .catch((error) => page.setFlash({ type: 'error', message: error.message }));

  return (
    <PageView page={page}>
      <Stack.Screen options={{ title: s.subjectName || page.title || 'Subject' }} />

      <Card title={s.subjectName}>
        {s.tutor ? (
          <View style={styles.tutor}>
            <Avatar path={s.tutor.imagePath} name={s.tutor.name} />
            <View style={styles.flex}>
              <Body style={styles.bold}>{s.tutor.name}</Body>
              {s.tutor.email ? <Muted>{s.tutor.email}</Muted> : null}
              {s.tutor.contactNumber ? <Muted>{s.tutor.contactNumber}</Muted> : null}
            </View>
            <Button title="Profile" tone="secondary" small onPress={() => router.push(`/tutors/${s.tutor.id}`)} />
          </View>
        ) : <Muted>No tutor yet. Choose one in My Subjects.</Muted>}
        <Row label="Schedule" value={[s.preferredDays, s.timeSlot].filter(Boolean).join(', ')} />
        <Row label="Month" value={s.startDate ? `${formatDate(s.startDate)} – ${formatDate(s.endDate)}` : ''} />
        {d.gradeLevel ? <Row label="Grade level" value={d.gradeLevel} /> : null}
      </Card>

      {d.viewOnlyNote ? <Notice tone="info" icon="eye-outline">{d.viewOnlyNote}</Notice> : null}
      {d.monthNote ? <Notice tone="warning" icon="time-outline">{d.monthNote}</Notice> : null}

      <Card title="Pre-Assessment">
        {d.preAssessment ? (
          <>
            <View style={styles.inline}>
              <Body>Done — {percent(d.preAssessment.percentage)}</Body>
              <Badge text={d.preAssessment.level} tone={levelTone(d.preAssessment.level)} />
            </View>
            <Button title="View my result" tone="secondary" onPress={() => router.push(`/results/${d.preAssessment.submissionId}`)} />
          </>
        ) : d.preGate ? (
          d.preGate.canStart ? (
            <>
              <Body>Take the Pre-Assessment to unlock your modules. It finds what you already know and where to start.</Body>
              <Button title="Take Pre-Assessment" icon="play-circle-outline" onPress={() => router.push(d.preGate.startPath)} />
            </>
          ) : (
            <>
              <Notice tone="warning" icon="lock-closed-outline">{d.preGate.message}</Notice>
              {d.preGate.goToBilling ? <Button title="Go to Billing" tone="secondary" onPress={() => router.navigate('/billing')} /> : null}
            </>
          )
        ) : <Muted>Not available.</Muted>}
      </Card>

      {d.learningPath ? (
        <Card
          title="My Learning Path"
          right={d.learningPath.placementLevel ? <Badge text={d.learningPath.placementLevel} tone={levelTone(d.learningPath.placementLevel)} /> : null}
        >
          <Muted>Passed {d.learningPath.passed} of {d.learningPath.total} modules. Each opens after you pass the one before it.</Muted>
          {d.learningPath.modules.map((m) => (
            <ListItem
              key={m.id}
              icon={m.status === 'passed' ? 'checkmark-circle' : m.status === 'locked' ? 'lock-closed-outline' : 'book-outline'}
              title={`Module ${m.number} — ${m.title}`}
              subtitle={m.status === 'locked' && m.opensAfter ? `Opens after you pass Module ${m.opensAfter}` : (m.weakPointCount ? `${m.weakPointCount} weak point${m.weakPointCount === 1 ? '' : 's'} added for you` : '')}
              right={<Badge text={STATUS_LABELS[m.status] || m.status} tone={m.status === 'passed' ? 'green' : m.status === 'locked' ? 'grey' : 'blue'} />}
              onPress={m.status === 'locked' ? undefined : () => router.push(m.path)}
            />
          ))}
        </Card>
      ) : (
        <Card title="Modules">
          {(d.modules || []).length ? d.modules.map((m) => (
            <ListItem
              key={m.id}
              icon={d.preAssessment ? 'book-outline' : 'lock-closed-outline'}
              title={`Module ${m.number} — ${m.title}`}
              subtitle={m.levelModule ? `${m.levelModule.level} lesson` : (m.handoutCount ? `${m.handoutCount} handout${m.handoutCount === 1 ? '' : 's'}` : '')}
              onPress={() => router.push(m.path)}
            />
          )) : <Empty>No modules yet.</Empty>}
        </Card>
      )}

      {d.post ? (
        <Card title="Post-Assessment">
          {d.post.submission ? (
            <>
              <View style={styles.inline}>
                <Body>Done — {percent(d.post.submission.percentage)}</Body>
                <Badge text={d.post.submission.level} tone={levelTone(d.post.submission.level)} />
              </View>
              <Button title="View my result" tone="secondary" onPress={() => router.push(`/results/${d.post.submission.id}`)} />
            </>
          ) : null}
          {d.post.note ? <Body>{d.post.note}</Body> : null}
          {d.post.startPath ? <Button title="Take Post-Assessment" icon="play-circle-outline" onPress={() => router.push(d.post.startPath)} /> : null}
          {d.post.stillToDo ? (
            <>
              <Muted>Modules opened {d.post.stillToDo.modulesOpened} of {d.post.stillToDo.modulesTotal}</Muted>
              {d.post.stillToDo.assessments.map((a) => (
                <ListItem key={a.id} icon="create-outline" title={a.title} subtitle="Still to answer" onPress={() => router.push(a.path)} />
              ))}
            </>
          ) : null}
          {d.post.comparison ? <BeforeAfter c={d.post.comparison} /> : null}
        </Card>
      ) : null}

      {d.pathScores && d.pathScores.comparison ? (
        <Card title="Before and After">
          <BeforeAfter c={{
            prePercentage: d.pathScores.comparison.prePct,
            preLevel: d.pathScores.comparison.preLevel,
            postPercentage: d.pathScores.comparison.postPct,
            postLevel: d.pathScores.comparison.postLevel,
            delta: d.pathScores.comparison.delta
          }}
          />
          {d.pathScores.modules.map((m) => (
            <Row
              key={m.number}
              label={`Module ${m.number} — ${m.title}`}
              value={`${m.prePct === null ? '—' : percent(m.prePct)} → ${m.postPct === null ? '—' : percent(m.postPct)}`}
            />
          ))}
        </Card>
      ) : null}

      {d.pathScores && d.pathScores.rows && d.pathScores.rows.length ? (
        <Card title="All my scores">
          {d.pathScores.rows.map((r, i) => (
            <ListItem
              key={`${r.kind}-${i}`}
              title={r.title}
              subtitle={[r.module, r.at ? formatDate(r.at) : '', r.passed === true ? 'Passed' : r.passed === false ? 'Not passed' : ''].filter(Boolean).join(' · ')}
              right={<Badge text={r.percentage === null ? `${r.score}/${r.total}` : percent(r.percentage)} tone={levelTone(r.level)} />}
              onPress={r.path ? () => router.push(r.path) : undefined}
            />
          ))}
        </Card>
      ) : null}

      {(d.legacyModules || []).length || (d.sharedFiles || []).length ? (
        <Card title="Files">
          {[...(d.legacyModules || []), ...(d.sharedFiles || [])].map((f) => (
            <ListItem
              key={`f${f.id}`}
              icon="document-text-outline"
              title={f.title}
              subtitle={[f.type, f.description].filter(Boolean).join(' · ')}
              onPress={f.fileUrl ? () => openFile(f) : undefined}
            />
          ))}
        </Card>
      ) : null}

      <Card title="Attendance">
        {(d.attendance || []).length ? d.attendance.map((a, i) => (
          <View key={`a${i}`} style={styles.attendance}>
            <Body style={styles.flex}>{formatDate(a.date)}</Body>
            <Badge
              text={a.status ? a.status[0].toUpperCase() + a.status.slice(1) : '—'}
              tone={a.status === 'present' ? 'green' : a.status === 'late' ? 'amber' : a.status === 'absent' ? 'red' : 'blue'}
            />
          </View>
        )) : <Empty>No attendance recorded yet.</Empty>}
      </Card>
    </PageView>
  );
}

/** The Pre-Assessment against the Post-Assessment. */
function BeforeAfter({ c }) {
  const delta = Number(c.delta || 0);
  return (
    <View style={styles.compare}>
      <View style={styles.compareSide}>
        <Muted>Before</Muted>
        <Body style={styles.big}>{percent(c.prePercentage)}</Body>
        <Badge text={c.preLevel} tone={levelTone(c.preLevel)} />
      </View>
      <Body style={[styles.delta, { color: delta >= 0 ? COLORS.green : COLORS.danger }]}>{delta >= 0 ? '+' : ''}{percent(delta)}</Body>
      <View style={styles.compareSide}>
        <Muted>After</Muted>
        <Body style={styles.big}>{percent(c.postPercentage)}</Body>
        <Badge text={c.postLevel} tone={levelTone(c.postLevel)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  tutor: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  attendance: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  compare: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingVertical: 6 },
  compareSide: { alignItems: 'center', gap: 4 },
  big: { fontSize: 22, fontWeight: '800' },
  delta: { fontSize: 18, fontWeight: '800' }
});
