/**
 * File: src/components/TakeAssessment.js
 * Purpose: Answering an assessment — one screen for all four kinds:
 *
 *   /subjects/:id/pre-assessment     the Pre-Assessment
 *   /subjects/:id/post-assessment    the Post-Assessment
 *   /tutor-assessments/:id           a tutor's activity or module test
 *   /path-modules/:id/assessment     a learning-path module's assessment
 *
 * The questions arrive WITHOUT their answers (the server strips the answer
 * key before sending). The answers are posted as the website's form posts
 * them: answer_<questionId>, with assessment_id, started_at and session_key.
 *
 * ANTI-CHEAT (the website's rules, enforced by the server)
 *   - Screenshots and screen recording are blocked while this screen is open.
 *   - Leaving the app (Home, another app, the recent-apps list) is reported to
 *     the server's violation endpoint. The SERVER counts the strikes and says
 *     when the limit is reached; the app then submits by itself with
 *     auto_submitted = "anti_cheat_limit", exactly like the website.
 *   - Leaving the screen asks first, because the answers would be lost.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { Stack, useNavigation, usePreventRemove, useRouter } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { usePage } from '../lib/usePage';
import { postAction } from '../lib/api';
import { confirm, followAnswer } from '../lib/navigation';
import { COLORS } from '../lib/config';
import { Body, Button, Card, Muted, Notice, PageView } from './ui';

const AUTO_SUBMIT_MARKER = 'anti_cheat_limit'; // public/js/anti-cheat.js

export function TakeAssessment({ path }) {
  // FLAG_SECURE on Android: no screenshots, no screen recording, a blank
  // preview in the recent-apps list — only while this screen is mounted.
  usePreventScreenCapture('take-assessment');

  const router = useRouter();
  const page = usePage(path, { once: true });
  const d = page.data;
  const [answers, setAnswers] = useState({});
  const [strikes, setStrikes] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [finished, setFinished] = useState(false); // handed in, or left on purpose
  const done = useRef(false);        // the same, for the event handlers below
  const answersRef = useRef(answers);
  useEffect(() => { answersRef.current = answers; }, [answers]);

  // Ask before leaving with answers that would be lost. "Leave" lifts the
  // block first (finished), then the effect below carries out the navigation
  // that was held back.
  const navigation = useNavigation();
  const [leaveAction, setLeaveAction] = useState(null);
  const blocking = !!d && !finished && !submitting;
  const disablePrevention = usePreventRemove(blocking, ({ data }) => {
    Alert.alert('Leave this assessment?', 'Your answers will not be saved.', [
      { text: 'Stay', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          setFinished(true);
          setLeaveAction(data.action);
        }
      }
    ]);
  });
  useEffect(() => {
    if (finished && leaveAction) navigation.dispatch(leaveAction);
  }, [finished, leaveAction, navigation]);

  /** Post the answers. `auto` = the anti-cheat limit was reached. */
  const submit = useCallback(async ({ auto = false } = {}) => {
    if (!d || done.current) return;
    const body = {
      assessment_id: d.assessment.id,
      started_at: d.startedAt,
      session_key: d.antiCheat ? d.antiCheat.sessionKey : undefined
    };
    for (const q of d.questions) body[`answer_${q.id}`] = answersRef.current[q.id] || '';
    if (auto) body.auto_submitted = AUTO_SUBMIT_MARKER;
    setSubmitting(true);
    try {
      const answer = await postAction(d.submitPath, body, { from: path });
      done.current = true;
      setFinished(true);
      disablePrevention();
      // The result (or the module page) takes this screen's place: Back must
      // not return to a form that was already handed in.
      await followAnswer(router, answer, { current: path, replace: true, onFlash: page.setFlash });
    } catch (error) {
      setSubmitting(false);
      page.setFlash({ type: 'error', message: error.message });
    }
  }, [d, path, router, page, disablePrevention]);

  // Leaving the app while answering is a strike, counted by the server.
  useEffect(() => {
    if (!d || !d.antiCheat) return undefined;
    let wasActive = AppState.currentState === 'active';
    const subscription = AppState.addEventListener('change', async (next) => {
      if (next === 'active') { wasActive = true; return; }
      if (!wasActive || next !== 'background' || done.current) return;
      wasActive = false;
      try {
        const verdict = await postAction(d.antiCheat.endpoint, {
          type: 'tab_switch',
          detail: 'Left the MindQuest app during the assessment (Android)',
          session_key: d.antiCheat.sessionKey
        }, { from: path });
        if (verdict && verdict.count) setStrikes(verdict.count);
        if (verdict && verdict.autoSubmit) {
          Alert.alert('Assessment submitted', 'You left the app too many times, so your answers were submitted automatically.');
          await submit({ auto: true });
        } else if (verdict && verdict.count) {
          Alert.alert(
            `Warning ${verdict.count} of ${verdict.limit}`,
            `Leaving the app during an assessment is recorded. At ${verdict.limit} warnings your answers are submitted automatically.`
          );
        }
      } catch (_error) {
        // Not recorded (offline): the server stays the only judge of strikes.
      }
    });
    return () => subscription.remove();
  }, [d, path, submit]);

  const handIn = async () => {
    const unanswered = d.questions.filter((q) => !String(answers[q.id] || '').trim()).length;
    if (unanswered && d.requireAll) {
      page.setFlash({ type: 'error', message: `Answer every item first — ${unanswered} still blank.` });
      return;
    }
    const message = unanswered
      ? `${unanswered} item${unanswered === 1 ? ' is' : 's are'} still blank. Submit anyway? You cannot change your answers after.`
      : 'Submit your answers? You cannot change them after.';
    if (await confirm('Submit', message, 'Submit')) await submit();
  };

  const setAnswer = (id, value) => setAnswers((a) => ({ ...a, [id]: value }));

  return (
    <PageView page={page}>
      <Stack.Screen options={{ title: (d && d.assessment.label) || (d && d.assessment.title) || 'Assessment' }} />
      {d ? (
        <>
          <Card title={d.assessment.title}>
            {d.subjectName ? <Muted>{d.subjectName}</Muted> : null}
            {d.assessment.instructions ? <Body>{d.assessment.instructions}</Body> : null}
            <Muted>{d.questions.length} item{d.questions.length === 1 ? '' : 's'} · Screenshots are blocked · Stay in the app until you submit.</Muted>
          </Card>
          {d.antiCheat && strikes > 0 ? (
            <Notice tone="warning" icon="warning-outline">
              {`You left the app ${strikes} time${strikes === 1 ? '' : 's'}. At ${d.antiCheat.limit} your answers are submitted automatically.`}
            </Notice>
          ) : null}

          {d.questions.map((q) => (
            <Card key={q.id}>
              <Text style={styles.number}>Item {q.number} · {q.points} pt{q.points === 1 ? '' : 's'}</Text>
              <Body style={styles.question}>{q.text}</Body>
              {q.choices ? q.choices.map((choice) => {
                const on = answers[q.id] === choice.value;
                return (
                  <Pressable
                    key={choice.value}
                    onPress={() => setAnswer(q.id, choice.value)}
                    style={[styles.choice, on && styles.choiceOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                  >
                    <Text style={[styles.letter, on && styles.letterOn]}>{choice.label}</Text>
                    <Text style={[styles.choiceText, on && styles.choiceTextOn]}>{choice.text}</Text>
                  </Pressable>
                );
              }) : (
                <TextInput
                  value={answers[q.id] || ''}
                  onChangeText={(text) => setAnswer(q.id, text)}
                  style={[styles.input, q.type === 'essay' && styles.essay]}
                  placeholder={q.type === 'essay' ? 'Write your answer in your own words' : 'Type your answer'}
                  multiline={q.type === 'essay'}
                  textAlignVertical={q.type === 'essay' ? 'top' : 'center'}
                  autoCorrect={false}
                  contextMenuHidden
                />
              )}
            </Card>
          ))}

          <Button title={submitting ? 'Submitting…' : 'Submit answers'} icon="send-outline" disabled={submitting} onPress={handIn} />
        </>
      ) : null}
    </PageView>
  );
}

const styles = StyleSheet.create({
  number: { color: COLORS.green, fontWeight: '800', fontSize: 13 },
  question: { fontWeight: '600' },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border, backgroundColor: '#fff' },
  choiceOn: { borderColor: COLORS.green, backgroundColor: COLORS.greenSoft },
  letter: { width: 28, height: 28, borderRadius: 14, textAlign: 'center', textAlignVertical: 'center', fontWeight: '800', color: COLORS.greenDark, backgroundColor: COLORS.background },
  letterOn: { backgroundColor: COLORS.green, color: '#fff' },
  choiceText: { flex: 1, color: COLORS.text, fontSize: 15 },
  choiceTextOn: { color: COLORS.greenDark, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: COLORS.text, backgroundColor: '#fff' },
  essay: { minHeight: 120 }
});
