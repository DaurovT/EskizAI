/** Ошибка API в форме сервера: {"error": {"code", "message", "details"}}. status 0 — нет сети. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isNetwork() { return this.status === 0; }
  get isPaymentRequired() { return this.status === 402; }
  get isNotFound() { return this.status === 404; }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export async function parseError(res: { status: number; text(): Promise<string> }): Promise<ApiError> {
  let body: unknown = null;
  try {
    const t = await res.text();
    body = t ? JSON.parse(t) : null;
  } catch {
    /* не JSON */
  }
  const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  if (err) return new ApiError(res.status, err.code ?? 'error', err.message ?? `HTTP ${res.status}`, err.details);
  const detail = (body as { detail?: unknown } | null)?.detail; // FastAPI по умолчанию
  return new ApiError(res.status, `http_${res.status}`, typeof detail === 'string' ? detail : `HTTP ${res.status}`, detail);
}
