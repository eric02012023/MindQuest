/**
 * File: src/app/notifications/archive.js
 * Purpose: Archived notifications (/student/notifications/archive), each with Recover.
 */
import { useRouter } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { postAction } from '../../lib/api';
import { followAnswer } from '../../lib/navigation';
import { Card, Empty, PageView } from '../../components/ui';
import { AlertRow } from '../../components/AlertRow';

const HERE = '/notifications/archive';

export default function ArchiveScreen() {
  const router = useRouter();
  const page = usePage(HERE);
  const d = page.data || {};

  const recover = async (alert) => {
    try {
      const answer = await postAction(`/alerts/${alert.id}/recover`, {}, { from: HERE });
      await followAnswer(router, answer, { current: HERE, reload: page.reload, onFlash: page.setFlash });
    } catch (error) {
      page.setFlash({ type: 'error', message: error.message });
    }
  };

  return (
    <PageView page={page}>
      <Card title="Archived">
        {(d.archived || []).length
          ? d.archived.map((alert) => <AlertRow key={alert.id} alert={alert} onRecover={recover} />)
          : <Empty>No archived notifications.</Empty>}
      </Card>
    </PageView>
  );
}
