/**
 * File: src/components/NotificationBell.js
 * Purpose: The bell in the header, with the unread count every page reports
 *          (the same number as the website's bell). Opens Notifications.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useNotificationCount } from '../lib/store';
import { COLORS } from '../lib/config';

export function NotificationBell() {
  const router = useRouter();
  const count = useNotificationCount();
  return (
    <Pressable
      onPress={() => router.push('/notifications')}
      hitSlop={10}
      style={styles.bell}
      accessibilityRole="button"
      accessibilityLabel={count ? `Notifications, ${count} unread` : 'Notifications'}
    >
      <Ionicons name="notifications-outline" size={24} color="#ffffff" />
      {count > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bell: { marginRight: 14, padding: 2 },
  badge: {
    position: 'absolute', top: -4, right: -6, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: COLORS.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' }
});
