/**
 * File: src/app/tutor-assessments/[id].js
 * Purpose: A tutor's activity or module test (/student/tutor-assessments/:id).
 * One already answered is sent to its result by the server.
 */
import { useLocalSearchParams } from 'expo-router';
import { TakeAssessment } from '../../components/TakeAssessment';

export default function TutorAssessmentScreen() {
  const { id } = useLocalSearchParams();
  return <TakeAssessment path={`/tutor-assessments/${id}`} />;
}
