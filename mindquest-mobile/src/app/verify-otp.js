/**
 * File: src/app/verify-otp.js
 * Purpose: The 4-digit code emailed when a student logs in on a new phone.
 *
 * Right code -> logged in, and this phone is trusted next time (no code).
 * "Resend code" asks for a new one (at most five an hour, as on the website);
 * "Use another account" goes back to Login.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../lib/auth';
import { COLORS } from '../lib/config';
import { Button, FlashBanner, Muted } from '../components/ui';

export default function VerifyOtpScreen() {
  const router = useRouter();
  const auth = useAuth();
  const params = useLocalSearchParams();
  const pendingToken = String(params.pendingToken || '');
  const [maskedEmail, setMaskedEmail] = useState(String(params.maskedEmail || ''));
  const [code, setCode] = useState('');
  const [message, setMessage] = useState(params.note ? { type: String(params.noteType || 'success'), message: String(params.note) } : null);

  const verify = async () => {
    if (!/^\d{4}$/.test(code)) {
      setMessage({ type: 'error', message: 'Enter the 4-digit code from your email.' });
      return;
    }
    try {
      await auth.verifyOtp(pendingToken, code);
      // Logged in: Stack.Protected opens Home.
    } catch (error) {
      setMessage({ type: 'error', message: error.message });
      if (error.auth === false) router.replace('/login');
    }
  };

  const resend = async () => {
    try {
      const answer = await auth.resendOtp(pendingToken);
      if (answer.maskedEmail) setMaskedEmail(answer.maskedEmail);
      setMessage({ type: answer.emailSent === false ? 'error' : 'success', message: answer.message || 'A new code was sent.' });
    } catch (error) {
      setMessage({ type: 'error', message: error.message });
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <FlashBanner flash={message} onClose={() => setMessage(null)} />
      <View style={styles.card}>
        <Text style={styles.title}>Check your email</Text>
        <Muted>
          {maskedEmail ? `We sent a 4-digit code to ${maskedEmail}.` : 'We sent a 4-digit code to your email.'} It works for 10 minutes.
        </Muted>
        <TextInput
          value={code}
          onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 4))}
          style={styles.code}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={4}
          placeholder="••••"
          autoFocus
          onSubmitEditing={verify}
          accessibilityLabel="4-digit code"
        />
        <Button title="Verify" onPress={verify} />
        <Button title="Resend code" tone="secondary" onPress={resend} />
      </View>
      <Pressable onPress={() => router.replace('/login')} hitSlop={8} style={styles.center}>
        <Text style={styles.link}>Use another account</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, padding: 24, gap: 16, backgroundColor: COLORS.background },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 12, borderWidth: 1, borderColor: COLORS.border },
  title: { fontSize: 20, fontWeight: '800', color: COLORS.greenDark },
  code: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, paddingVertical: 12, fontSize: 30,
    letterSpacing: 16, textAlign: 'center', color: COLORS.text, fontWeight: '800'
  },
  center: { alignItems: 'center' },
  link: { color: COLORS.green, fontWeight: '700', fontSize: 14 }
});
