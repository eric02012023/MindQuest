/**
 * File: src/app/assessment-result/[id].js
 * Purpose: The website's older result address (/student/assessment-result/:id).
 *          The server answers it with the page it belongs to now, so this
 *          screen shows whatever that is.
 */
import { useLocalSearchParams } from 'expo-router';
import { ResultView } from '../../components/ResultView';

export default function AssessmentResultScreen() {
  const { id } = useLocalSearchParams();
  return <ResultView path={`/assessment-result/${id}`} />;
}
