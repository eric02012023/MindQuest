/**
 * File: src/app/(tabs)/_layout.js
 * Purpose: The five tabs — Home, Subjects, Progress, Billing, Profile — each
 *          with the notification bell in its header.
 */
import { Tabs } from 'expo-router/js-tabs';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../../lib/config';
import { NotificationBell } from '../../components/NotificationBell';

const tabIcon = (name) => function TabIcon({ color, size }) {
  return <Ionicons name={name} color={color} size={size} />;
};

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: COLORS.greenDark },
        headerTintColor: '#ffffff',
        headerTitleStyle: { fontWeight: '700' },
        headerRight: () => <NotificationBell />,
        tabBarActiveTintColor: COLORS.green,
        tabBarInactiveTintColor: COLORS.muted,
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' }
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: tabIcon('home-outline') }} />
      <Tabs.Screen name="subjects" options={{ title: 'My Subjects', tabBarLabel: 'Subjects', tabBarIcon: tabIcon('book-outline') }} />
      <Tabs.Screen name="progress" options={{ title: 'My Progress', tabBarLabel: 'Progress', tabBarIcon: tabIcon('stats-chart-outline') }} />
      <Tabs.Screen name="billing" options={{ title: 'Billing Data', tabBarLabel: 'Billing', tabBarIcon: tabIcon('wallet-outline') }} />
      <Tabs.Screen name="profile" options={{ title: 'My Profile', tabBarLabel: 'Profile', tabBarIcon: tabIcon('person-circle-outline') }} />
    </Tabs>
  );
}
