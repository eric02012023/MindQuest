/**
 * File: src/app/_layout.js
 * Purpose: The app's frame — the login state around everything, and one
 *          stack of screens split by Stack.Protected:
 *
 *   logged out -> Login and the code screen only;
 *   logged in  -> the tabs and every page under them.
 *
 * Switching between the two (logging in, logging out, or the server ending
 * the login) needs no code here: Stack.Protected moves the student to the
 * first screen they are allowed to see.
 */
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { AuthProvider, useAuth } from '../lib/auth';
import { COLORS } from '../lib/config';

// Keep the MindQuest splash up until we know whether someone is logged in.
SplashScreen.preventAutoHideAsync().catch(() => {});

const HEADER = {
  headerStyle: { backgroundColor: COLORS.greenDark },
  headerTintColor: '#ffffff',
  headerTitleStyle: { fontWeight: '700' },
  contentStyle: { backgroundColor: COLORS.background }
};

function RootStack() {
  const { ready, signedIn } = useAuth();

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return null;

  return (
    <Stack screenOptions={HEADER}>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="verify-otp" options={{ title: 'Enter your code' }} />
      </Stack.Protected>

      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="subjects/[id]/index" options={{ title: 'Subject' }} />
        <Stack.Screen name="subjects/[id]/pre-assessment" options={{ title: 'Pre-Assessment' }} />
        <Stack.Screen name="subjects/[id]/post-assessment" options={{ title: 'Post-Assessment' }} />
        <Stack.Screen name="tutors/[id]" options={{ title: 'Tutor Profile' }} />
        <Stack.Screen name="modules/[id]" options={{ title: 'Module' }} />
        <Stack.Screen name="level-modules/[id]" options={{ title: 'Module' }} />
        <Stack.Screen name="path-modules/[id]/index" options={{ title: 'My Module' }} />
        <Stack.Screen name="path-modules/[id]/assessment" options={{ title: 'Module Assessment' }} />
        <Stack.Screen name="tutor-assessments/[id]" options={{ title: 'Assessment' }} />
        <Stack.Screen name="results/[id]" options={{ title: 'Result' }} />
        <Stack.Screen name="assessment-result/[id]" options={{ title: 'Result' }} />
        <Stack.Screen name="billing/slip" options={{ title: 'Payment Slip' }} />
        <Stack.Screen name="notifications/index" options={{ title: 'Notifications' }} />
        <Stack.Screen name="notifications/archive" options={{ title: 'Archived Notifications' }} />
        <Stack.Screen name="notifications/history" options={{ title: 'Notification History' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <RootStack />
    </AuthProvider>
  );
}
