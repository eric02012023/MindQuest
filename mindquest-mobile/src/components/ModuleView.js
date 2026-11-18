/**
 * File: src/components/ModuleView.js
 * Purpose: A module — the office's (/modules/:id) or the one written for the
 *          student's level (/level-modules/:id): the lesson, the handouts
 *          (opened through the same lock as the website), and the activities.
 */
import { Stack, useRouter } from 'expo-router';
import { usePage } from '../lib/usePage';
import { openProtectedFile } from '../lib/api';
import { percent } from '../lib/format';
import { Badge, Body, Button, Card, Empty, ListItem, Muted, Notice, PageView, ProgressBar, levelTone } from './ui';
import { LessonPart } from './LessonText';

export function ModuleView({ path }) {
  const router = useRouter();
  const page = usePage(path);
  const d = page.data;
  const m = (d && d.module) || {};

  const openHandout = (h) => {
    if (!h.fileUrl) {
      page.setFlash({ type: 'error', message: 'This handout cannot be opened in the app. Please open it on the website.' });
      return;
    }
    openProtectedFile(h.fileUrl, h.fileName || `${h.title}.pdf`).catch((error) => page.setFlash({ type: 'error', message: error.message }));
  };

  const work = (item) => (item.done
    ? () => router.push(`/results/${item.done.submissionId}`)
    : d.viewOnlyNote ? undefined : () => router.push(`/tutor-assessments/${item.id}`));

  return (
    <PageView page={page}>
      <Stack.Screen options={{ title: m.number ? `Module ${m.number}` : 'Module' }} />
      {d ? (
        <>
          <Card title={`Module ${m.number || ''} — ${m.title || ''}`} right={d.lesson ? <Badge text={d.lesson.level} tone={levelTone(d.lesson.level)} /> : null}>
            {m.subjectName ? <Muted>{m.subjectName}</Muted> : null}
            {m.description ? <Body>{m.description}</Body> : null}
          </Card>

          {d.viewOnlyNote ? <Notice tone="info" icon="eye-outline">{d.viewOnlyNote}</Notice> : null}

          {d.levelModuleLink ? (
            <Card title={`Your ${d.levelModuleLink.level} module`}>
              <Body>This module was written again for your level. Its lesson and activities are there.</Body>
              <Button title={`Open the ${d.levelModuleLink.level} module`} onPress={() => router.push(d.levelModuleLink.path)} />
            </Card>
          ) : null}

          {d.lesson ? (
            <Card title="Lesson">
              {d.lesson.parts.length
                ? d.lesson.parts.map((part) => <LessonPart key={part.number} number={part.number} title={part.title} text={part.text} />)
                : <Muted>{d.lesson.status === 'failed'
                  ? 'This lesson is not ready yet. The handouts of this module have the same material.'
                  : 'Being prepared. It appears here in a minute or two — pull down to refresh.'}</Muted>}
            </Card>
          ) : null}

          <Card title="Handouts">
            {d.handouts.length ? d.handouts.map((h) => (
              <ListItem
                key={h.id}
                icon="document-attach-outline"
                title={h.title}
                subtitle={h.sizeKb ? `${h.sizeKb} KB` : ''}
                onPress={() => openHandout(h)}
              />
            )) : <Empty>No handouts on this module yet.</Empty>}
          </Card>

          {d.progress ? (
            <Card title="My progress">
              <ProgressBar percent={d.progress.percent} />
              <Muted>{d.progress.completed} of {d.progress.total} done</Muted>
            </Card>
          ) : null}

          {d.activities.length || d.postTests.length ? (
            <Card title="Activities">
              {[...d.activities, ...d.postTests].map((a) => (
                <ListItem
                  key={a.id}
                  icon={a.done ? 'checkmark-circle' : 'create-outline'}
                  title={a.title}
                  subtitle={a.done ? `Done — ${a.done.score}/${a.done.totalPoints}` : 'Not answered yet'}
                  right={a.done ? <Badge text={percent(a.done.percentage)} tone="green" /> : null}
                  onPress={work(a)}
                />
              ))}
            </Card>
          ) : null}
        </>
      ) : null}
    </PageView>
  );
}
