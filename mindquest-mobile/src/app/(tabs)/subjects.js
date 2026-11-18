/**
 * File: src/app/(tabs)/subjects.js
 * Purpose: My Subjects (/student/subjects): the subjects the student takes,
 *          choosing a tutor for one still without, and enrolling in more.
 *
 * SELECT TUTOR — the website's dialog, one subject at a time:
 *   1. the days (Weekdays / Weekend),
 *   2. an hour still free on those days (not an hour the student already
 *      spends on another subject),
 *   3. the tutors free at that day and hour -> View profile / Select.
 * The lists come from the server (getTutorChoicesForStudent), and the server
 * checks the choice again when it is sent (createTutorScheduleRequest).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { postAction } from '../../lib/api';
import { confirm, followAnswer } from '../../lib/navigation';
import { COLORS } from '../../lib/config';
import { Avatar, Badge, Body, Button, Card, Empty, ListItem, Muted, PageView } from '../../components/ui';

const HERE = '/subjects';

/** Can two sessions on these days collide? "Not set" collides with both (lib/data.js daysOverlap). */
const daysOverlap = (a, b) => !a || !b || a === b;

export default function SubjectsScreen() {
  const router = useRouter();
  const page = usePage(HERE);
  const d = page.data || {};
  const choices = d.tutorChoices || { subjects: [], held: [], timeSlots: [], preferredDays: [] };
  const [pick, setPick] = useState(null); // { subjectId, days, slot }

  const send = async (path, body) => {
    try {
      const answer = await postAction(path, body, { from: HERE });
      await followAnswer(router, answer, { current: HERE, reload: page.reload, onFlash: page.setFlash });
    } catch (error) {
      page.setFlash({ type: 'error', message: error.message });
    }
  };

  const enroll = async (subject) => {
    if (await confirm('Enroll', `Send a request to enroll in ${subject.name}? The office will review it.`, 'Send request')) {
      await send(`/subjects/${subject.id}/enroll`, {});
    }
  };

  const choiceFor = (subjectId) => choices.subjects.find((s) => s.subjectId === subjectId) || null;
  const subject = pick ? choiceFor(pick.subjectId) : null;
  const freeSlots = pick && pick.days
    ? choices.timeSlots.filter((slot) => !choices.held.some((h) => h.timeSlot === slot && daysOverlap(h.days, pick.days)))
    : [];
  const freeTutors = subject && pick.days && pick.slot
    ? subject.tutors.filter((t) => !t.blocked.includes(`${pick.days}|${pick.slot}`))
    : [];

  const select = async (tutor) => {
    const ok = await confirm(
      'Select this tutor',
      `Ask ${tutor.name} to teach you ${subject.subjectName} on ${pick.days}, ${pick.slot}? You will be notified once they accept.`,
      'Send request'
    );
    if (!ok) return;
    await send('/apply-tutor', {
      subject_id: pick.subjectId,
      tutor_id: tutor.id,
      time_slot: pick.slot,
      preferred_days: pick.days
    });
    setPick(null);
  };

  return (
    <PageView page={page}>
      {pick && subject ? (
        <Card title={`Select a tutor — ${subject.subjectName}`} right={<Button title="Close" tone="secondary" small onPress={() => setPick(null)} />}>
          <Muted>1. Choose your days</Muted>
          <Chips items={choices.preferredDays} value={pick.days} onChange={(days) => setPick({ ...pick, days, slot: '' })} />
          {pick.days ? (
            <>
              <Muted>2. Choose a time that is free for you</Muted>
              {freeSlots.length
                ? <Chips items={freeSlots} value={pick.slot} onChange={(slot) => setPick({ ...pick, slot })} />
                : <Empty>Every time on {pick.days} is taken by your other subjects. Try other days.</Empty>}
            </>
          ) : null}
          {pick.days && pick.slot ? (
            <>
              <Muted>3. Choose your tutor</Muted>
              {freeTutors.length ? freeTutors.map((tutor) => (
                <View key={tutor.id} style={styles.tutor}>
                  <Avatar path={tutor.imagePath} name={tutor.name} />
                  <View style={styles.flex}>
                    <Body style={styles.bold}>{tutor.name}</Body>
                    {tutor.yearLevels.length ? <Muted>{tutor.yearLevels.join(', ')}</Muted> : null}
                    {tutor.alsoYours.length ? <Muted>Already your tutor in {tutor.alsoYours.join(', ')}</Muted> : null}
                    <View style={styles.actions}>
                      <Button
                        title="View profile"
                        tone="secondary"
                        small
                        onPress={() => router.push(`/tutors/${tutor.id}?subject=${pick.subjectId}&days=${encodeURIComponent(pick.days)}&slot=${encodeURIComponent(pick.slot)}`)}
                      />
                      <Button title="Select" small onPress={() => select(tutor)} />
                    </View>
                  </View>
                </View>
              )) : <Empty>No tutor is free on {pick.days} at {pick.slot}. Try another time.</Empty>}
            </>
          ) : null}
        </Card>
      ) : null}

      <Card title="Enrolled Subjects">
        {(d.enrolled || []).length ? d.enrolled.map((s) => (
          <View key={s.subjectId}>
            <ListItem
              icon="book-outline"
              title={s.subjectName}
              subtitle={s.tutorName
                ? `${s.tutorName} · ${[s.preferredDays, s.timeSlot].filter(Boolean).join(', ')}`
                : s.pending
                  ? `Waiting for ${s.pending.tutorName} to accept (${s.pending.preferredDays}, ${s.pending.timeSlot})`
                  : 'No tutor yet'}
              right={<StatusBadge subject={s} />}
              onPress={() => router.push(`/subjects/${s.subjectId}`)}
            />
            {s.canChooseTutor ? (
              <Button
                title="Select Tutor"
                icon="person-add-outline"
                small
                style={styles.selectButton}
                onPress={() => setPick({ subjectId: s.subjectId, days: '', slot: '' })}
              />
            ) : null}
          </View>
        )) : <Empty>You are not enrolled in a subject yet.</Empty>}
      </Card>

      <Card title="All Subjects">
        {(d.allSubjects || []).length ? d.allSubjects.map((subjectRow) => (
          <View key={subjectRow.id} style={styles.subjectRow}>
            <Body style={styles.flex}>{subjectRow.name}</Body>
            {subjectRow.status === 'enrolled' ? <Badge text="Enrolled" tone="green" />
              : subjectRow.status === 'pending' ? <Badge text="Pending" tone="amber" />
                : <Button title="Enroll" small onPress={() => enroll(subjectRow)} />}
          </View>
        )) : <Empty>No subjects are offered yet.</Empty>}
      </Card>
    </PageView>
  );
}

function StatusBadge({ subject }) {
  if (subject.viewOnly) return <Badge text="View only" />;
  if (subject.tutorName) return <Badge text="Active" tone="green" />;
  if (subject.pending) return <Badge text="Pending" tone="amber" />;
  return <Badge text="No tutor" tone="red" />;
}

function Chips({ items, value, onChange }) {
  return (
    <View style={styles.chips}>
      {items.map((item) => (
        <Pressable
          key={item}
          onPress={() => onChange(item)}
          style={[styles.chip, value === item && styles.chipOn]}
          accessibilityRole="radio"
          accessibilityState={{ checked: value === item }}
        >
          <Text style={[styles.chipText, value === item && styles.chipTextOn]}>{item}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: '700' },
  tutor: { flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  selectButton: { alignSelf: 'flex-start', marginLeft: 34, marginBottom: 6 },
  subjectRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: COLORS.border, backgroundColor: '#fff' },
  chipOn: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  chipText: { color: COLORS.text, fontWeight: '600' },
  chipTextOn: { color: '#fff' }
});
