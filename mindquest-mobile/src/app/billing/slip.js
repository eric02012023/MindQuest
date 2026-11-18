/**
 * File: src/app/billing/slip.js
 * Purpose: The payment slip (/student/billing/slip) the student shows at the
 *          branch counter, and the same slip as a PDF to keep or send.
 */
import { StyleSheet, Text } from 'react-native';
import { Stack } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { openProtectedFile } from '../../lib/api';
import { formatDate, formatDateTime, money } from '../../lib/format';
import { COLORS } from '../../lib/config';
import { Button, Card, Empty, Muted, PageView, Row } from '../../components/ui';

export default function SlipScreen() {
  const page = usePage('/billing/slip');
  const d = page.data;
  const slip = (d && d.slip) || {};
  const totals = slip.totals || {};

  const openPdf = () => openProtectedFile(d.pdfUrl, `${slip.code || 'payment-slip'}.pdf`)
    .catch((error) => page.setFlash({ type: 'error', message: error.message }));

  return (
    <PageView page={page}>
      <Stack.Screen options={{ title: 'Payment Slip' }} />
      {d ? (
        <>
          <Card>
            <Text style={styles.code}>{slip.code || 'No slip code yet'}</Text>
            <Muted>{d.hasOpenSlip ? `Show this at ${slip.branchName || 'your branch'} to pay.` : 'You have no open slip. Generate one on Billing Data.'}</Muted>
            <Row label="Student" value={`${slip.studentName} (${slip.studentCode})`} />
            <Row label="Branch" value={slip.branchName} />
            <Row label="Issued" value={formatDateTime(slip.issuedAt)} />
            {slip.dueDate ? <Row label="Due" value={formatDate(slip.dueDate)} /> : null}
          </Card>
          <Card title="Subjects">
            {slip.subjects.length ? slip.subjects.map((s, i) => (
              <Row key={`s${i}`} label={`${s.name}${s.startDate ? ` (${formatDate(s.startDate)} – ${formatDate(s.endDate)})` : ''}`} value={money(s.amount)} />
            )) : <Empty>No subjects billed.</Empty>}
          </Card>
          <Card title="Amounts">
            <Row label="Billed" value={money(totals.billed)} />
            <Row label="Paid" value={money(totals.paid)} />
            <Row label="Balance" value={money(totals.remaining)} strong />
            <Row label={slip.floorKind === 'down_payment' ? 'Down payment required' : 'Pay at least'} value={money(slip.minimumNow)} />
            {slip.declaredAmount ? <Row label="You will pay" value={money(slip.declaredAmount)} strong /> : null}
          </Card>
          <Button title="Open PDF" icon="document-outline" onPress={openPdf} />
        </>
      ) : null}
    </PageView>
  );
}

const styles = StyleSheet.create({
  code: { fontSize: 26, fontWeight: '800', color: COLORS.greenDark, letterSpacing: 1 }
});
