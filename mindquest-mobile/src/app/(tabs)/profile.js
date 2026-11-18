/**
 * File: src/app/(tabs)/profile.js
 * Purpose: My Profile (/student/profile): the fields a student may change,
 *          a new photo, and Log out.
 *
 * The year level, grade level, branch and login email are set by the office:
 * shown here, never sent (the server ignores them anyway — routes/student.js).
 * Every editable field is sent back on save, exactly as the website's form
 * sends them, so nothing is blanked by being left out.
 * Only the photo library is asked for (no camera, no microphone).
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { usePage } from '../../lib/usePage';
import { postForm } from '../../lib/api';
import { confirm, followAnswer } from '../../lib/navigation';
import { useAuth } from '../../lib/auth';
import { formatDate } from '../../lib/format';
import { COLORS } from '../../lib/config';
import { Avatar, Button, Card, Muted, PageView, Row } from '../../components/ui';

const HERE = '/profile';

/** The website form's fields, in its order, with their labels. */
const FIELDS = [
  ['first_name', 'First name'],
  ['middle_name', 'Middle name'],
  ['last_name', 'Last name'],
  ['birth_date', 'Birth date (YYYY-MM-DD)'],
  ['age', 'Age'],
  ['contact_number', 'Contact number'],
  ['parent_email', 'Parent / student email'],
  ['parent_facebook', 'Parent / student Facebook'],
  ['parent_guardian_name', 'Parent / guardian name'],
  ['parent_contact_number', 'Parent contact'],
  ['address', 'Address']
];

function formFrom(p) {
  return {
    first_name: p.firstName || '',
    middle_name: p.middleName || '',
    last_name: p.lastName || '',
    birth_date: p.birthDateInput || '',
    age: p.age === null || p.age === undefined ? '' : String(p.age),
    gender: p.gender || '',
    contact_number: p.contactNumber || '',
    parent_email: p.parentEmail || '',
    parent_facebook: p.parentFacebook || '',
    parent_guardian_name: p.parentGuardianName || '',
    parent_contact_number: p.parentContactNumber || '',
    address: p.address || ''
  };
}

export default function ProfileScreen() {
  const router = useRouter();
  const auth = useAuth();
  const page = usePage(HERE);
  const profile = (page.data && page.data.profile) || {};
  // What the student has typed, over what the server has: the form shows
  // the saved profile until a field is changed.
  const [edits, setEdits] = useState({});
  const form = page.data && page.data.profile ? { ...formFrom(page.data.profile), ...edits } : null;
  const [photo, setPhoto] = useState(null); // the picked image, not yet saved

  const set = (key) => (value) => setEdits((e) => ({ ...e, [key]: value }));

  const pickPhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      page.setFlash({ type: 'error', message: 'Allow MindQuest to use your photos to change your profile picture.' });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.7 });
    if (!result.canceled && result.assets && result.assets[0]) setPhoto(result.assets[0]);
  };

  const save = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) {
      page.setFlash({ type: 'error', message: 'First name and last name are required.' });
      return;
    }
    if (form.birth_date && !/^\d{4}-\d{2}-\d{2}$/.test(form.birth_date)) {
      page.setFlash({ type: 'error', message: 'Write the birth date as YYYY-MM-DD, e.g. 2012-05-03.' });
      return;
    }
    const data = new FormData();
    Object.entries(form).forEach(([key, value]) => data.append(key, String(value)));
    if (photo) {
      data.append('image', {
        uri: photo.uri,
        name: photo.fileName || `profile-${Date.now()}.jpg`,
        type: photo.mimeType || 'image/jpeg'
      });
    }
    try {
      const answer = await postForm(HERE, data, { from: HERE });
      setPhoto(null);
      setEdits({});
      await followAnswer(router, answer, { current: HERE, reload: page.reload, onFlash: page.setFlash });
    } catch (error) {
      page.setFlash({ type: 'error', message: error.message });
    }
  };

  const logout = async () => {
    if (await confirm('Log out', 'Log out of MindQuest on this phone? You will need the emailed code next time.', 'Log out')) {
      await auth.logout();
    }
  };

  return (
    <PageView page={page}>
      <View style={styles.head}>
        <Pressable onPress={pickPhoto} accessibilityRole="button" accessibilityLabel="Change profile photo">
          {photo
            ? <Avatar localUri={photo.uri} name="" size={88} />
            : <Avatar path={profile.imagePath} name={`${profile.firstName || ''} ${profile.lastName || ''}`} size={88} />}
          <Text style={styles.change}>{photo ? 'New photo chosen — Save to keep it' : 'Change photo'}</Text>
        </Pressable>
        <Text style={styles.name}>{[profile.firstName, profile.lastName].filter(Boolean).join(' ')}</Text>
        <Muted>{profile.code}</Muted>
      </View>

      <Card title="Set by the office">
        <Row label="Login email" value={profile.email} />
        <Row label="Year level" value={profile.yearLevel} />
        <Row label="Grade level" value={profile.gradeLevel} />
        <Row label="Branch" value={profile.branchName} />
        <Row label="Member since" value={formatDate(profile.joinedAt)} />
      </Card>

      {form ? (
        <Card title="My details">
          {FIELDS.map(([key, label]) => (
            <View key={key} style={styles.field}>
              <Text style={styles.label}>{label}</Text>
              <TextInput
                value={form[key]}
                onChangeText={set(key)}
                style={styles.input}
                keyboardType={key === 'age' ? 'number-pad' : key.includes('contact') ? 'phone-pad' : key === 'parent_email' ? 'email-address' : 'default'}
                autoCapitalize={key === 'parent_email' || key === 'parent_facebook' ? 'none' : 'words'}
              />
            </View>
          ))}
          <Text style={styles.label}>Gender</Text>
          <View style={styles.genders}>
            {['Female', 'Male'].map((g) => (
              <Pressable key={g} onPress={() => set('gender')(g)} style={[styles.chip, form.gender === g && styles.chipOn]}>
                <Text style={[styles.chipText, form.gender === g && styles.chipTextOn]}>{g}</Text>
              </Pressable>
            ))}
          </View>
          <Button title="Save" icon="save-outline" onPress={save} />
        </Card>
      ) : null}

      {(page.data && page.data.tutors && page.data.tutors.length) ? (
        <Card title="My Tutors">
          {page.data.tutors.map((t) => <Row key={t.id} label={t.name} value={t.schedule} />)}
        </Card>
      ) : null}

      <Button title="Log out" tone="danger" icon="log-out-outline" onPress={logout} />
    </PageView>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 4 },
  change: { color: COLORS.green, fontWeight: '700', textAlign: 'center', marginTop: 6 },
  name: { fontSize: 20, fontWeight: '800', color: COLORS.greenDark },
  field: { gap: 4 },
  label: { fontSize: 13, fontWeight: '700', color: COLORS.text },
  input: { borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15, color: COLORS.text, backgroundColor: '#fff' },
  genders: { flexDirection: 'row', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: COLORS.border },
  chipOn: { backgroundColor: COLORS.green, borderColor: COLORS.green },
  chipText: { color: COLORS.text, fontWeight: '600' },
  chipTextOn: { color: '#fff' }
});
