/**
 * File: src/app/notifications/history.js
 * Purpose: Notification History (/student/notifications/history): the
 *          student's tutor requests and how they ended, and notifications read.
 */
import { usePage } from '../../lib/usePage';
import { formatDateTime } from '../../lib/format';
import { Badge, Card, Empty, ListItem, PageView } from '../../components/ui';
import { AlertRow } from '../../components/AlertRow';

const TONES = { accepted: 'green', pending: 'amber', rejected: 'red', cancelled: 'red', declined: 'red' };

export default function HistoryScreen() {
  const page = usePage('/notifications/history');
  const d = page.data || {};

  return (
    <PageView page={page}>
      <Card title="Tutor requests">
        {(d.requests || []).length ? d.requests.map((r, i) => (
          <ListItem
            key={`r${i}`}
            title={`${r.subjectName} — ${r.tutorName}`}
            subtitle={[r.preferredDays, r.timeSlot, r.decidedAt ? formatDateTime(r.decidedAt) : ''].filter(Boolean).join(' · ')}
            right={<Badge text={r.status} tone={TONES[String(r.status).toLowerCase()] || 'grey'} />}
          />
        )) : <Empty>No requests yet.</Empty>}
      </Card>
      <Card title="Read notifications">
        {(d.read || []).length ? d.read.map((alert) => <AlertRow key={alert.id} alert={alert} />) : <Empty>Nothing here yet.</Empty>}
      </Card>
    </PageView>
  );
}
