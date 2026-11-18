/**
 * File: src/app/subjects/[id]/pre-assessment.js
 * Purpose: The Pre-Assessment (/student/subjects/:id/pre-assessment).
 * The server decides whether it may open (down payment, grade, handouts) and
 * sends the reason back instead when it may not.
 */
import { useLocalSearchParams } from 'expo-router';
import { TakeAssessment } from '../../../components/TakeAssessment';

export default function PreAssessmentScreen() {
  const { id } = useLocalSearchParams();
  return <TakeAssessment path={`/subjects/${id}/pre-assessment`} />;
}
