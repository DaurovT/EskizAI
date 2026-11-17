/**
 * Просьбы клиента «Хочу изменить…» по проекту (ClientRequests.dc.html — тот же список, только этого проекта):
 * «Новые · Все», тап — просьба («Изменить модель», «Ответить», «Сделано»). Общий список цеха — /client-requests.
 */
import { useLocalSearchParams } from 'expo-router';
import { ClientRequestsList } from '../../../src/screens/ClientRequests';

export default function ProjectClientRequests() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ClientRequestsList projectId={id} />;
}
