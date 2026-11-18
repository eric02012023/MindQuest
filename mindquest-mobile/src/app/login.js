/**
 * File: src/app/login.js
 * Purpose: Log in with the website account (students only).
 *
 * The server checks everything the website's login checks. A phone verified
 * before logs in at once; any other phone goes on to the 4-digit code.
 * Registering and resetting a password stay on the website.
 */
import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useAuth } from '../lib/auth';
import { COLORS, WEBSITE_URL } from '../lib/config';
import { Button, FlashBanner } from '../components/ui';

export default function LoginScreen() {
  const router = useRouter();
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState(null);

  const notice = auth.notice ? { type: 'error', message: auth.notice } : null;

  const submit = async () => {
    setMessage(null);
    auth.clearNotice();
    if (!email.trim() || !password) {
      setMessage({ type: 'error', message: 'Enter your email and password.' });
      return;
    }
    try {
      const result = await auth.login(email, password);
      if (result.otpRequired) {
        router.push({
          pathname: '/verify-otp',
          params: {
            pendingToken: result.pendingToken,
            maskedEmail: result.maskedEmail || '',
            note: result.message || '',
            noteType: result.emailSent ? 'success' : 'error'
          }
        });
      }
      // Logged in: Stack.Protected opens Home by itself.
    } catch (error) {
      setMessage({ type: 'error', message: error.message });
    }
  };

  const openWebsite = (path) => WebBrowser.openBrowserAsync(`${WEBSITE_URL}${path}`, { toolbarColor: COLORS.greenDark });

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}>
          <Image source={require('../../assets/icon.png')} style={styles.logo} accessibilityLabel="MindQuest logo" />
          <Text style={styles.title}>MindQuest</Text>
          <Text style={styles.subtitle}>Student app</Text>
        </View>

        <FlashBanner flash={message || notice} onClose={() => { setMessage(null); auth.clearNotice(); }} />

        <View style={styles.form}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            style={styles.input}
            placeholder="you@gmail.com"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="next"
          />
          <Text style={styles.label}>Password</Text>
          <View>
            <TextInput
              value={password}
              onChangeText={setPassword}
              style={[styles.input, styles.passwordInput]}
              placeholder="Your password"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoComplete="password"
              returnKeyType="go"
              onSubmitEditing={submit}
            />
            <Pressable onPress={() => setShowPassword((v) => !v)} style={styles.show} hitSlop={8}>
              <Text style={styles.link}>{showPassword ? 'Hide' : 'Show'}</Text>
            </Pressable>
          </View>
          <Button title="Log in" onPress={submit} />
        </View>

        <View style={styles.links}>
          <Pressable onPress={() => openWebsite('/forgot-password')} hitSlop={8}>
            <Text style={styles.link}>Forgot password?</Text>
          </Pressable>
          <Pressable onPress={() => openWebsite('/register/student')} hitSlop={8}>
            <Text style={styles.link}>New student? Register on the website</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  page: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 16 },
  brand: { alignItems: 'center', gap: 4 },
  logo: { width: 110, height: 110, borderRadius: 55 },
  title: { fontSize: 28, fontWeight: '800', color: COLORS.greenDark },
  subtitle: { fontSize: 15, color: COLORS.muted },
  form: { backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 8, borderWidth: 1, borderColor: COLORS.border },
  label: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginTop: 4 },
  input: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: COLORS.text, backgroundColor: '#fff' },
  passwordInput: { paddingRight: 64 },
  show: { position: 'absolute', right: 12, top: 12 },
  links: { alignItems: 'center', gap: 14 },
  link: { color: COLORS.green, fontWeight: '700', fontSize: 14 }
});
