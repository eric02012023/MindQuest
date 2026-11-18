/**
 * File: src/app/results/[id].js
 * Purpose: A result (/student/results/:id) — the student's own only; the
 *          server sends anyone else's away.
 */
import { useLocalSearchParams } from 'expo-router';
import { ResultView } from '../../components/ResultView';

export default function ResultScreen() {
  const { id } = useLocalSearchParams();
  return <ResultView path={`/results/${id}`} />;
}
