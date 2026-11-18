/**
 * File: src/app/subjects/[id]/post-assessment.js
 * Purpose: The Post-Assessment (/student/subjects/:id/post-assessment), once
 *          the tutor has opened it.
 */
import { useLocalSearchParams } from 'expo-router';
import { TakeAssessment } from '../../../components/TakeAssessment';

export default function PostAssessmentScreen() {
  const { id } = useLocalSearchParams();
  return <TakeAssessment path={`/subjects/${id}/post-assessment`} />;
}
