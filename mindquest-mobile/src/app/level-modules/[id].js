/**
 * File: src/app/level-modules/[id].js
 * Purpose: A module written for the student's level (/student/level-modules/:id):
 *          the lesson, the handouts and the activities.
 */
import { useLocalSearchParams } from 'expo-router';
import { ModuleView } from '../../components/ModuleView';

export default function LevelModuleScreen() {
  const { id } = useLocalSearchParams();
  return <ModuleView path={`/level-modules/${id}`} />;
}
