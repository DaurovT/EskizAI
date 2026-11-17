/**
 * SCR-58 «Просьбы клиентов» по всему цеху (ClientRequests.dc.html): вход — из уведомлений и боковой панели планшета.
 * Широкий планшет — TRequests.dc.html (список + просьба, src/screens/ClientRequests.tsx).
 */
import { ClientRequestsList, ClientRequestsWide } from '../../src/screens/ClientRequests';
import { useLayout } from '../../src/ui/layout';

export default function ClientRequestsScreen() {
  const { wide } = useLayout();
  return wide ? <ClientRequestsWide /> : <ClientRequestsList />;
}
