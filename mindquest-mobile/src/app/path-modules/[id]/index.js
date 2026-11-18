/**
 * File: src/app/path-modules/[id]/index.js
 * Purpose: One module of the student's learning path (/student/path-modules/:id):
 *
 *   the module as one PDF (every original page with the pages added for them),
 *   "Added for You" — their weak points, five topics each — the takes of its
 *   assessment so far, their tutor's activities, and Take the assessment when
 *   it is open. Passing (Advance, 81%) opens the next module.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { usePage } from '../../../lib/usePage';
import { openProtectedFile } from '../../../lib/api';
import { formatDateTime, percent } from '../../../lib/format';
import { COLORS } from '../../../lib/config';
import { Badge, Body, Button, Card, Empty, ListItem, Muted, Notice, PageView, levelTone } from '../../../components/ui';

/** The website's sentences for an assessment that cannot be taken now (routes/student.js). */
const TAKE_STATE_MESSAGES = {
  locked: 'Pass the module before this one first.',
  preparing: 'Your assessment for this module is still being prepared.',
  waiting_tutor: 'Your tutor opens this assessment when you are ready for it.',
  waiting_retake: 'Your tutor opens your next take when you are ready for it.',
  passed: 'You have passed this module already.'
};

export default function PathModuleScreen() {
  const { id } = useLocalSearchParams();
  const router = useRouter();
  const page = usePage(`/path-modules/${id}`);
  const d = page.data;
  const m = (d && d.module) || {};

  const openPdf = () => openProtectedFile(m.pdfUrl, `module-${m.number || id}.pdf`)
    .catch((error) => page.setFlash({ type: 'error', message: error.message }));

  return (
    <PageView page={page}>
      <Stack.Screen options={{ title: m.number ? `Module ${m.number}` : 'My Module' }} />
      {d ? (
        <>
          <Card title={`Module ${m.number || ''} — ${m.title || ''}`} right={<Badge text={m.status} tone={m.status === 'passed' ? 'green' : 'blue'} />}>
            {m.subjectName ? <Muted>{m.subjectName}</Muted> : null}
            <Muted>Pass mark: {d.passLabel}</Muted>
            <Button title="Open my module (PDF)" icon="document-text-outline" onPress={openPdf} />
          </Card>

          {d.viewOnlyNote ? <Notice tone="info" icon="eye-outline">{d.viewOnlyNote}</Notice> : null}

          <Card title="Module Assessment">
            {m.assessmentPath && !d.viewOnlyNote ? (
              <>
                <Body>{d.attempts.length ? 'Your next take is open.' : 'Your assessment is open.'}</Body>
                <Button title="Take the assessment" icon="play-circle-outline" onPress={() => router.push(m.assessmentPath)} />
              </>
            ) : (
              <Muted>{TAKE_STATE_MESSAGES[m.takeState] || 'Not open yet.'}</Muted>
            )}
            {d.attempts.length ? d.attempts.map((a) => (
              <View key={a.number} style={styles.attempt}>
                <Body style={styles.flex}>Take {a.number}{a.submittedAt ? ` · ${formatDateTime(a.submittedAt)}` : ''}</Body>
                <Badge text={`${a.score}/${a.totalPoints} · ${percent(a.percentage)}`} tone={levelTone(a.level)} />
              </View>
            )) : null}
          </Card>

          {d.weakPoints.length ? (
            <Card title="Added for You">
              <Muted>Your weak points from the Pre-Assessment, each taught in five topics. They are in your module PDF too.</Muted>
              {d.weakPoints.map((point) => <WeakPoint key={point.no} point={point} />)}
            </Card>
          ) : null}

          <Card title="Activities">
            {d.activities.length ? d.activities.map((a) => (
              <ListItem
                key={a.id}
                icon={a.done ? 'checkmark-circle' : 'create-outline'}
                title={a.title}
                subtitle={a.done ? `Done — ${a.done.score}/${a.done.totalPoints}` : 'Not answered yet'}
                right={a.done ? <Badge text={percent(a.done.percentage)} tone="green" /> : null}
                onPress={a.done
                  ? () => router.push(`/results/${a.done.submissionId}`)
                  : d.viewOnlyNote ? undefined : () => router.push(`/tutor-assessments/${a.id}`)}
              />
            )) : <Empty>No activities yet.</Empty>}
          </Card>
        </>
      ) : null}
    </PageView>
  );
}

/** One weak point and its five topics, folded until tapped. */
function WeakPoint({ point }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.point}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.pointHead} accessibilityRole="button">
        <Text style={styles.pointTitle}>{point.no}. {point.title}</Text>
        <Text style={styles.toggle}>{open ? 'Hide' : 'Show'}</Text>
      </Pressable>
      {point.focus ? <Muted>{point.focus}</Muted> : null}
      {open ? point.topics.map((topic) => (
        <View key={topic.no} style={styles.topic}>
          <Text style={styles.topicTitle}>{topic.no}. {topic.title}</Text>
          <Body>{topic.text}</Body>
        </View>
      )) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  attempt: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  point: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border, gap: 4 },
  pointHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  pointTitle: { flex: 1, fontWeight: '700', color: COLORS.greenDark, fontSize: 15 },
  toggle: { color: COLORS.green, fontWeight: '700' },
  topic: { backgroundColor: COLORS.background, borderRadius: 8, padding: 10, gap: 4 },
  topicTitle: { fontWeight: '700', color: COLORS.text }
});
