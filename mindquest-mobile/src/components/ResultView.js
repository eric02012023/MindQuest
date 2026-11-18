/**
 * File: src/components/ResultView.js
 * Purpose: A graded submission, as the website's result page shows it:
 *
 *   the score and the level (Beginner 0–50%, Intermediate 51–80%,
 *   Advance 81–100%), the topics weakest first, then every item — with the
 *   correct answer and the reason ONLY on the items the student missed.
 *   (The server leaves the key out of the items answered right.)
 */
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { usePage } from '../lib/usePage';
import { formatDateTime, percent } from '../lib/format';
import { COLORS } from '../lib/config';
import { Badge, Body, Button, Card, Empty, Muted, PageView, ProgressBar, levelTone } from './ui';

const TYPE_LABELS = { multiple_choice: 'Multiple choice', true_false: 'True or False', fill_blank: 'Short answer', essay: 'Essay' };

export function ResultView({ path }) {
  const router = useRouter();
  const page = usePage(path);
  const d = page.data;
  const s = (d && d.submission) || {};

  return (
    <PageView page={page}>
      <Stack.Screen options={{ title: s.title || 'Result' }} />
      {d ? (
        <>
          <Card title={s.title}>
            <Muted>{[s.subjectName, s.submittedAt ? formatDateTime(s.submittedAt) : ''].filter(Boolean).join(' · ')}</Muted>
            <View style={styles.score}>
              <Text style={styles.percent}>{percent(s.percentage)}</Text>
              <Badge text={s.level} tone={levelTone(s.level)} />
            </View>
            <Body>Score {s.score} of {s.totalPoints} · {s.correct} correct, {s.incorrect} to review</Body>
            <View style={styles.bands}>
              {(d.bands || []).map((b) => (
                <View key={b.name} style={[styles.band, s.level === b.name && styles.bandOn]}>
                  <Text style={[styles.bandName, s.level === b.name && styles.bandNameOn]}>{b.name}</Text>
                  <Text style={styles.bandRange}>{b.range}</Text>
                </View>
              ))}
            </View>
          </Card>

          {d.topics.length ? (
            <Card title="Topics — weakest first">
              {d.topics.map((t, i) => (
                <View key={`t${i}`} style={styles.topic}>
                  <View style={styles.topicHead}>
                    <Body style={styles.flex}>{t.moduleNumber ? `Module ${t.moduleNumber} — ` : ''}{t.moduleTitle || t.handoutName}</Body>
                    {t.isWeak ? <Badge text="Weak" tone="red" /> : null}
                  </View>
                  <ProgressBar percent={t.percentage} />
                  <Muted>{t.correct} of {t.total} correct ({percent(t.percentage)})</Muted>
                </View>
              ))}
            </Card>
          ) : null}

          <Card title="Your answers">
            {d.answers.length ? d.answers.map((a) => (
              <View key={a.number} style={[styles.item, { borderLeftColor: a.isCorrect ? COLORS.green : COLORS.danger }]}>
                <View style={styles.topicHead}>
                  <Text style={styles.itemNo}>Item {a.number} · {TYPE_LABELS[a.type] || a.type}</Text>
                  <Badge text={`${a.isCorrect ? 'Correct' : 'Incorrect'} · ${a.pointsEarned}/${a.points}`} tone={a.isCorrect ? 'green' : 'red'} />
                </View>
                <Body style={styles.bold}>{a.text}</Body>
                <Muted>Your answer: {a.yourAnswer ? `${a.yourAnswer}${a.yourAnswerText ? ` — ${a.yourAnswerText}` : ''}` : '(blank)'}</Muted>
                {!a.isCorrect && a.correctAnswer ? (
                  <Text style={styles.correct}>Correct answer: {a.correctAnswer}{a.correctAnswerText ? ` — ${a.correctAnswerText}` : ''}</Text>
                ) : null}
                {!a.isCorrect && a.explanation ? <Muted>Why: {a.explanation}</Muted> : null}
                {a.feedback ? <Muted>Feedback: {a.feedback}</Muted> : null}
                {a.source ? <Muted style={styles.source}>{a.source}</Muted> : null}
              </View>
            )) : <Empty>No answers to show.</Empty>}
          </Card>

          {s.subjectId ? <Button title="Back to the subject" tone="secondary" onPress={() => router.push(`/subjects/${s.subjectId}`)} /> : null}
        </>
      ) : null}
    </PageView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: '600' },
  score: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  percent: { fontSize: 36, fontWeight: '800', color: COLORS.greenDark },
  bands: { flexDirection: 'row', gap: 6 },
  band: { flex: 1, padding: 8, borderRadius: 8, backgroundColor: COLORS.background, alignItems: 'center' },
  bandOn: { backgroundColor: COLORS.greenSoft, borderWidth: 1, borderColor: COLORS.green },
  bandName: { fontSize: 12, fontWeight: '700', color: COLORS.muted },
  bandNameOn: { color: COLORS.greenDark },
  bandRange: { fontSize: 11, color: COLORS.muted },
  topic: { gap: 4, paddingVertical: 6 },
  topicHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  item: { borderLeftWidth: 4, paddingLeft: 10, paddingVertical: 8, gap: 4 },
  itemNo: { fontSize: 12, fontWeight: '800', color: COLORS.muted },
  correct: { color: COLORS.greenDark, fontWeight: '700' },
  source: { fontStyle: 'italic' }
});
