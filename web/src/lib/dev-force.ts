import type { ArDevForce, ArStep } from '@/components/ArLauncher';

/**
 * Только для разработки: принудительные состояния страницы клиента для сверки
 * с макетами. В production всегда пусто.
 *   ?ar=yes|no                     — есть ли AR на устройстве
 *   ?arStep=intro|loading|after    — открыть шторку AR на шаге
 *   ?status=expired|revoked|not_found — экран «ссылка недоступна»
 *   ?agreed=1                      — клиент уже согласовал
 */
export interface DevForce {
  ar?: ArDevForce;
  status?: 'expired' | 'revoked' | 'not_found';
  agreed?: boolean;
}

export type DevParams = { ar?: string; arStep?: string; status?: string; agreed?: string };

export function devForce(q: DevParams): DevForce {
  if (process.env.NODE_ENV === 'production') return {};
  const out: DevForce = {};
  const ar: ArDevForce = {};
  if (q.ar === 'yes' || q.ar === 'no') ar.available = q.ar === 'yes';
  if (q.arStep === 'intro' || q.arStep === 'loading' || q.arStep === 'after') {
    ar.step = q.arStep as ArStep;
    ar.available ??= true;
  }
  if (ar.available !== undefined || ar.step) out.ar = ar;
  if (q.status === 'expired' || q.status === 'revoked' || q.status === 'not_found') out.status = q.status;
  if (q.agreed === '1') out.agreed = true;
  return out;
}
