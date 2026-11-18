/**
 * File: src/app/(tabs)/billing.js
 * Purpose: Billing Data (/student/billing): what is owed, how to pay, and
 *          what has been paid.
 *
 *   Cash      -> "Generate payment slip": the student says how much they will
 *                pay; the slip is shown at the branch (no money moves here).
 *   Online    -> "Pay now": the server creates a PayMongo checkout and answers
 *                { external: url }; it opens in the phone's browser. When the
 *                student comes back to the app, Billing reloads with
 *                ?payment=success, which makes the server ask PayMongo at once.
 * The amount rules (down payment, instalment, never above the balance) are the
 * server's; the checks here only save a round trip.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { usePage } from '../../lib/usePage';
import { openProtectedFile, postAction } from '../../lib/api';
import { confirm, followAnswer } from '../../lib/navigation';
import { formatDate, formatDateTime, money } from '../../lib/format';
import { COLORS } from '../../lib/config';
import { Badge, Body, Button, Card, Empty, Muted, PageView, Row, Segments } from '../../components/ui';

const HERE = '/billing';

export default function BillingScreen() {
  const router = useRouter();
  const page = usePage(HERE);
  const d = page.data || {};
  const totals = d.totals || {};
  const floor = d.floor || {};
  const [method, setMethod] = useState('cash');
  // null = not typed yet: the amount box shows the balance, as the website's form does.
  const [typedAmount, setAmount] = useState(null);
  const amount = typedAmount === null ? Number(totals.remaining || 0).toFixed(2) : typedAmount;
  const [note, setNote] = useState('');
  const [tab, setTab] = useState('payments');
  const awaitingPayment = useRef(false);
  const reloadRef = useRef(page.reload);
  useEffect(() => { reloadRef.current = page.reload; });

  // Back from PayMongo's page: reload, asking the server to check the payment.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && awaitingPayment.current) {
        awaitingPayment.current = false;
        reloadRef.current({ at: `${HERE}?payment=success` });
      }
    });
    return () => subscription.remove();
  }, []);

  const remaining = Number(totals.remaining || 0);
  const minimum = Number(d.minimumPayment || 0);
  const online = (d.paymentMethods || []).find((m) => m.value === 'online');
  const cash = (d.paymentMethods || []).find((m) => m.value === 'cash');

  const checkAmount = () => {
    const value = Number(String(amount).replace(/[^0-9.]/g, ''));
    if (!value || value <= 0) return 'Enter a payment amount greater than zero.';
    if (value > remaining + 0.001) return `That is more than your balance. Pay at most ${money(remaining)}.`;
    if (minimum && value + 0.001 < minimum) {
      return floor.kind === 'down_payment'
        ? `The down payment is at least ${money(minimum)}.`
        : `Your next payment must be at least ${money(minimum)}.`;
    }
    return '';
  };

  const act = async (path, body) => {
    try {
      const answer = await postAction(path, body, { from: HERE });
      if (answer.external) awaitingPayment.current = true;
      setAmount(null); // back to the (new) balance
      await followAnswer(router, answer, { current: HERE, reload: page.reload, onFlash: page.setFlash });
    } catch (error) {
      page.setFlash({ type: 'error', message: error.message });
    }
  };

  const generateSlip = async () => {
    const problem = checkAmount();
    if (problem) return page.setFlash({ type: 'error', message: problem });
    if (await confirm('Generate payment slip', 'Generate a payment slip? Show it at the branch to pay — no money is taken now.', 'Generate')) {
      await act('/billing/slip', { amount: Number(amount), payment_method: 'cash', reference_note: note || undefined });
    }
    return undefined;
  };

  const payNow = async () => {
    const problem = checkAmount();
    if (problem) return page.setFlash({ type: 'error', message: problem });
    if (await confirm('Pay now', 'Continue to the secure PayMongo payment page?', 'Continue')) {
      await act('/billing/pay-online', { amount: Number(amount) });
    }
    return undefined;
  };

  return (
    <PageView page={page}>
      <Card title="Summary">
        <Row label="Total billed" value={money(totals.totalBilled)} />
        <Row label="Total paid" value={money(totals.totalPaid)} />
        <Row label="Balance" value={money(remaining)} strong />
        {d.paymentDue ? <Row label="Payment due" value={formatDate(d.paymentDue)} /> : null}
        {remaining > 0 ? (
          <Row label={floor.kind === 'down_payment' ? 'Down payment required' : 'Minimum next payment'} value={money(floor.amount)} strong />
        ) : null}
      </Card>

      <Card title="Pay">
        {d.pendingSlip ? (
          <>
            <Body>
              You have a payment slip open: {money(d.pendingSlip.amount)}, issued {formatDateTime(d.pendingSlip.createdAt)} — pay at {d.pendingSlip.branchName || 'your branch'}.
            </Body>
            <Button title="View my payment slip" icon="receipt-outline" onPress={() => router.push('/billing/slip')} />
            <Button
              title="Open PDF"
              tone="secondary"
              icon="document-outline"
              onPress={() => openProtectedFile('/api/mobile/student/billing/slip.pdf', 'payment-slip.pdf').catch((e) => page.setFlash({ type: 'error', message: e.message }))}
            />
          </>
        ) : remaining <= 0 ? (
          <Empty>{d.hasBill ? 'Your account is fully settled.' : 'You have not been billed yet.'}</Empty>
        ) : (
          <>
            <Segments
              items={[
                { value: 'cash', label: 'Cash (payment slip)' },
                ...(online && online.enabled ? [{ value: 'online', label: 'Online (PayMongo)' }] : [])
              ]}
              value={method}
              onChange={setMethod}
            />
            <Muted>{method === 'cash' ? (cash && cash.description) : (online && online.description)}</Muted>
            <Text style={styles.label}>{method === 'cash' ? 'Amount you intend to pay' : 'Amount to pay'}</Text>
            <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" style={styles.input} accessibilityLabel="Amount" />
            {method === 'cash' ? (
              <>
                <Text style={styles.label}>Notes for the office (optional)</Text>
                <TextInput value={note} onChangeText={setNote} style={styles.input} placeholder="e.g. with my guardian on Saturday" />
                <Button title="Generate payment slip" icon="receipt-outline" onPress={generateSlip} />
              </>
            ) : (
              <Button title="Pay now" icon="card-outline" onPress={payNow} />
            )}
          </>
        )}
      </Card>

      <Card title="History">
        <Segments
          items={[{ value: 'payments', label: 'Payments' }, { value: 'slips', label: 'Slips' }, { value: 'statements', label: 'Statements' }]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'payments' ? (
          (d.entries || []).length ? d.entries.map((e, i) => (
            <View key={`p${i}`} style={styles.item}>
              <View style={styles.itemHead}>
                <Body style={styles.bold}>{money(e.amount)}</Body>
                <Badge text={e.method} tone="green" />
              </View>
              <Muted>{formatDateTime(e.paidAt)} · {e.purpose}{e.referenceNo ? ` · Ref ${e.referenceNo}` : ''}</Muted>
              <Muted>Balance after: {money(e.balanceAfter)}</Muted>
            </View>
          )) : <Empty>No payments yet.</Empty>
        ) : null}
        {tab === 'slips' ? (
          (d.requests || []).length ? d.requests.map((r, i) => (
            <View key={`s${i}`} style={styles.item}>
              <View style={styles.itemHead}>
                <Body style={styles.bold}>{money(r.amount)}</Body>
                <Badge text={r.status} tone={r.status === 'pending' ? 'amber' : r.status === 'completed' ? 'green' : 'grey'} />
              </View>
              <Muted>{formatDateTime(r.createdAt)}{r.branchName ? ` · ${r.branchName}` : ''}</Muted>
            </View>
          )) : <Empty>No payment slips yet.</Empty>
        ) : null}
        {tab === 'statements' ? (
          (d.statements || []).length ? d.statements.map((s, i) => (
            <View key={`t${i}`} style={styles.item}>
              <View style={styles.itemHead}>
                <Body style={styles.bold}>{s.type}</Body>
                <Muted>{formatDate(s.statementDate)}</Muted>
              </View>
              <Row label="Full bill" value={money(s.fullBill)} />
              <Row label="Paid" value={money(s.paid)} />
              <Row label="Balance" value={money(s.balance)} strong />
              {s.paymentDue ? <Row label="Due" value={formatDate(s.paymentDue)} /> : null}
            </View>
          )) : <Empty>No statements yet.</Empty>
        ) : null}
      </Card>
    </PageView>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '700' },
  label: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  input: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.text, backgroundColor: '#fff' },
  item: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border, gap: 2 },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }
});
