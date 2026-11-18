/**
 * File: src/app/modules/[id].js
 * Purpose: A module of the office (/student/modules/:id): its handouts, and its
 *          activities when the student has no level module for it.
 */
import { useLocalSearchParams } from 'expo-router';
import { ModuleView } from '../../components/ModuleView';

export default function ModuleScreen() {
  const { id } = useLocalSearchParams();
  return <ModuleView path={`/modules/${id}`} />;
}
