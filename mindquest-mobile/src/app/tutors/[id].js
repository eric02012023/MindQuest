/**
 * File: src/app/tutors/[id].js
 * Purpose: A tutor's profile (/student/tutors/:id). Opened from Select Tutor it
 *          carries the subject, days and time chosen, and offers "Select this
 *          tutor" — when the server confirms that hour is still free.
 */
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { postAction } from '../../lib/api';
import { confirm, followAnswer } from '../../lib/navigation';
import { Avatar, Body, Button, Card, Muted, Notice, PageView, Row } from '../../components/ui';

export default function TutorProfileScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const query = params.subject
    ? `?subject=${encodeURIComponent(params.subject)}&days=${encodeURIComponent(params.days || '')}&slot=${encodeURIComponent(params.slot || '')}`
    : '';
  const here = `/tutors/${params.id}${query}`;
  const page = usePage(here);
  const d = page.data;
  const t = (d && d.tutor) || {};
  const pick = d && d.pick;

  const select = async () => {
    const ok = await confirm(
      'Select this tutor',
      `Ask ${t.name} to teach you ${pick.subjectName} on ${pick.preferredDays}, ${pick.timeSlot}? You will be notified once they accept.`,
      'Send request'
    );
    if (!ok) return;
    try {
      const answer = await postAction('/apply-tutor', {
        subject_id: pick.subjectId, tutor_id: t.id, time_slot: pick.timeSlot, preferred_days: pick.preferredDays
      }, { from: here });
      await followAnswer(router, answer, { current: here, reload: page.reload, onFlash: page.setFlash });
    } catch (error) {
      page.setFlash({ type: 'error', message: error.message });
    }
  };

  return (
    <PageView page={page}>
      <Stack.Screen options={{ title: t.name || 'Tutor Profile' }} />
      {d ? (
        <>
          <View style={styles.head}>
            <Avatar path={t.imagePath} name={t.name} size={96} />
            <Body style={styles.name}>{t.name}</Body>
            <Muted>{t.code}</Muted>
          </View>
          {pick ? (
            <Card title={`For ${pick.subjectName}`}>
              <Row label="Days" value={pick.preferredDays} />
              <Row label="Time" value={pick.timeSlot} />
              {pick.alsoYours.length ? <Muted>Already your tutor in {pick.alsoYours.join(', ')}.</Muted> : null}
              {pick.canSelect
                ? <Button title="Select this tutor" icon="checkmark-circle-outline" onPress={select} />
                : <Notice tone="warning">{pick.waiting ? 'You already have a request waiting for this subject.' : 'This tutor is not free at that time any more. Go back and choose another time or tutor.'}</Notice>}
            </Card>
          ) : null}
          <Card title="About">
            <Row label="Subjects" value={t.subjects.join(', ')} />
            <Row label="Teaches" value={t.yearLevel} />
            <Row label="Branch" value={t.branchName} />
            <Row label="Gender" value={t.gender} />
            <Row label="Email" value={t.email} />
            <Row label="Contact" value={t.contactNumber} />
            {t.facebookAccount ? <Row label="Facebook" value={t.facebookAccount} /> : null}
          </Card>
        </>
      ) : null}
    </PageView>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 4 },
  name: { fontSize: 20, fontWeight: '800' }
});
