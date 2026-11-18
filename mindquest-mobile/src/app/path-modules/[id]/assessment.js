/**
 * File: src/app/path-modules/[id]/assessment.js
 * Purpose: The assessment of one module on the student's learning path
 *          (/student/path-modules/:id/assessment). Passing it (Advance, 81%)
 *          opens the next module; a retake opens by itself.
 */
import { useLocalSearchParams } from 'expo-router';
import { TakeAssessment } from '../../../components/TakeAssessment';

export default function PathModuleAssessmentScreen() {
  const { id } = useLocalSearchParams();
  return <TakeAssessment path={`/path-modules/${id}/assessment`} />;
}
