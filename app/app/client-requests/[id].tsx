/** Просьба клиента (ClientRequests.dc.html, карточка): сюда ведёт push client_change_request. На широком — список с выбранной. */
import { useLocalSearchParams } from 'expo-router';
import { ClientRequestItem, ClientRequestsWide } from '../../src/screens/ClientRequests';
import { useLayout } from '../../src/ui/layout';

export default function ClientRequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { wide } = useLayout();
  return wide ? <ClientRequestsWide selected={id} /> : <ClientRequestItem id={id} />;
}
