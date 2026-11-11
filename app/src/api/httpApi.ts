import type { Api, DownloadedFile, ProjectQuery, UploadFile } from './client';
import { ApiError } from './errors';
import { Http, type RequestOpts } from './http';
import type * as T from './types';

export type Downloader = (url: string, headers: Record<string, string>, fileName: string) => Promise<DownloadedFile>;

const enc = encodeURIComponent;

/** Нет эндпоинта (404/405) — значит, сервер его ещё не умеет. */
// FastAPI на неизвестный путь отвечает {"detail": "Not Found"} → code http_404; «нет сущности» — {"error": {"code": "not_found"}}.
export const missing = (e: unknown) => e instanceof ApiError && ((e.status === 404 && e.code === 'http_404') || e.status === 405);

/** Локальный файл (file://…) → Blob для FormData. Вне приложения (тесты) — объект {uri, name, type} как есть. */
function toBlob(file: UploadFile): Blob {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File } = require('expo-file-system') as typeof import('expo-file-system');
    return new File(file.uri) as unknown as Blob;
  } catch {
    return file as unknown as Blob;
  }
}

/** Списки новых ручек: сервер может отдать массив или страницу {items}. */
const items = <R>(r: R[] | { items: R[] }): R[] => (Array.isArray(r) ? r : r.items ?? []);

/** Фото к сообщению / рекламации / спору — повторяющееся поле files (multipart, как у фото проекта). */
function appendFiles(form: FormData, files?: UploadFile[]) {
  for (const f of files ?? []) form.append('files', toBlob(f), f.name);
}

export function createHttpApi(http: Http, download?: Downloader): Api {
  const get = <R>(p: string, query?: RequestOpts['query']) => http.request<R>(p, { query });
  const post = <R>(p: string, body: unknown = {}) => http.request<R>(p, { method: 'POST', body });
  const patch = <R>(p: string, body: unknown) => http.request<R>(p, { method: 'PATCH', body });
  const del = <R>(p: string) => http.request<R>(p, { method: 'DELETE' });
  const pj = (id: string) => `/projects/${enc(id)}`;

  return {
    mode: 'http',
    requestCode: (phone, channel = 'telegram') => http.request('/auth/request-code', { method: 'POST', body: { phone, channel }, auth: false }),
    verifyCode: (body) => http.request('/auth/verify-code', { method: 'POST', body, auth: false }),
    me: () => get('/auth/me'),
    updateMe: (body) => patch('/auth/me', body),
    logout: async (refresh_token) => { await http.request('/auth/logout', { method: 'POST', body: { refresh_token }, auth: false }); },
    myInvite: () => get('/auth/invite'),
    acceptInvite: (id) => post(`/auth/invite/${enc(id)}/accept`),
    declineInvite: async (id) => { await post(`/auth/invite/${enc(id)}/decline`); },
    requestDeleteCode: (channel = 'sms') => post('/auth/delete-account/request-code', { channel }),
    deleteAccount: (code) => post('/auth/delete-account', { code }),
    appStatus: (platform, version) => http.request('/app/status', { query: { platform, version }, auth: false }),

    getWorkshop: () => get('/workshops/me'),
    updateWorkshop: (body) => patch('/workshops/me', body),
    getPricing: () => get('/workshops/me/pricing'),
    updatePricing: (body) => patch('/workshops/me/pricing', body),
    listEmployees: () => get('/workshops/me/employees'),
    addEmployee: (phone, name) => post('/workshops/me/employees', { phone, name }),
    inviteEmployee: (body) => post('/workshops/me/invites', body),
    listInvites: () => get('/workshops/me/invites'),
    resendInvite: (id) => post(`/workshops/me/invites/${enc(id)}/resend`),
    cancelInvite: async (id) => { await del(`/workshops/me/invites/${enc(id)}`); },
    updateEmployee: (id, body) => patch(`/workshops/me/employees/${enc(id)}`, body),
    removeEmployee: async (id) => { await del(`/workshops/me/employees/${enc(id)}`); },
    limits: () => get('/billing/limits'),
    uploadLogo: (file: UploadFile) => {
      const form = new FormData();
      form.append('file', toBlob(file), file.name); // как фото: File из expo-file-system — это Blob
      return http.request('/workshops/me/logo', { method: 'POST', form });
    },
    deleteLogo: () => del('/workshops/me/logo'),
    listPayments: async () => (await get<{ items: T.PaymentOut[] }>('/billing/payments')).items,

    listClients: (q) => get('/clients', { q, limit: 200 }),
    createClient: (body) => post('/clients', body),
    getClient: (id) => get(`/clients/${enc(id)}`),
    updateClient: (id, body) => patch(`/clients/${enc(id)}`, body),

    listProjects: (q: ProjectQuery = {}) =>
      get('/projects', { status: q.status, q: q.q, client_id: q.client_id, archived: q.archived, limit: q.limit ?? 100, offset: q.offset }),
    createProject: (body) => post('/projects', body),
    createExample: () => post('/projects/example'),
    getProject: (id) => get(pj(id)),
    updateProject: (id, body) => patch(pj(id), body),
    deleteProject: async (id) => { await del(pj(id)); },
    archiveProject: (id) => post(`${pj(id)}/archive`),
    unarchiveProject: (id) => post(`${pj(id)}/unarchive`),
    duplicateProject: (id) => post(`${pj(id)}/duplicate`),
    uploadPhoto: (projectId, file: UploadFile, kind = 'source') => {
      const form = new FormData();
      // В Expo SDK 58 глобальный fetch — expo/fetch: он принимает Blob, а не RN-объект {uri}.
      // File из expo-file-system реализует Blob (байты читает сам), поэтому фото — как File.
      form.append('file', toBlob(file), file.name);
      form.append('kind', kind);
      return http.request(`${pj(projectId)}/photos`, { method: 'POST', form });
    },
    deletePhoto: async (projectId, photoId) => { await del(`${pj(projectId)}/photos/${enc(photoId)}`); },

    toSketch: (id) => post(`${pj(id)}/sketch`),
    addMeasurement: (id, body) => post(`${pj(id)}/measurements`, body),
    listMeasurements: (id) => get(`${pj(id)}/measurements`),
    toContract: (id) => post(`${pj(id)}/contract`),
    deliver: (id, materials_self_bought) => post(`${pj(id)}/deliver`, { materials_self_bought }),
    cancelProject: (id, reason) => post(`${pj(id)}/cancel`, { reason: reason ?? null }),

    getModel: (id) => get(`${pj(id)}/model`),
    saveModel: (id, body) => post(`${pj(id)}/model`, body),
    undo: (id) => post(`${pj(id)}/model/undo`),
    redo: (id) => post(`${pj(id)}/model/redo`),
    applyFix: (id, issue_index, fix_index) => post(`${pj(id)}/model/fixes`, { issue_index, fix_index }),
    listVersions: (id) => get(`${pj(id)}/versions`),
    getVersion: (id, vid) => get(`${pj(id)}/versions/${enc(vid)}`),
    restoreVersion: (id, vid) => post(`${pj(id)}/versions/${enc(vid)}/restore`),
    confirmEstimated: (id, vid, pointers) => post(`${pj(id)}/versions/${enc(vid)}/confirm`, { pointers }),
    getHardware: (id) => get(`${pj(id)}/hardware`),
    applyHardware: (id, key, value) => post(`${pj(id)}/hardware`, { key, value }),

    getEstimate: (id) => get(`${pj(id)}/estimate`),
    getClientEstimate: (id, view) => get(`${pj(id)}/estimate/client`, { view }),
    getNesting: (id) => get(`${pj(id)}/nesting`),
    listPriceRequests: (id) => get(`${pj(id)}/price-requests`),
    decidePriceRequest: (id, rid, accept) => post(`${pj(id)}/price-requests/${enc(rid)}/${accept ? 'accept' : 'decline'}`),
    listDecors: async () => (await get<{ items: T.DecorOut[] }>('/catalog/decors')).items,
    searchDecors: (query) => get('/catalog/decors', query as RequestOpts['query']),
    listPaintColors: () => get('/catalog/paint-colors'),
    getFrontStyles: () => get('/catalog/front-styles'),
    getLightingZones: () => get('/catalog/lighting-zones'),
    getBuiltinOptions: () => get('/catalog/builtin-options'),

    createShareLink: (id, body) => post(`${pj(id)}/share-links`, body),
    listShareLinks: (id) => get(`${pj(id)}/share-links`),

    getTask: (taskId) => get(`/tasks/${enc(taskId)}`),
    aiDesign: (id, body) => post(`${pj(id)}/ai/design`, body),
    aiAnswer: (id, answers, confirm, notes) => {
      const list = Object.entries(answers).map(([question_id, value]) => ({ question_id, value }));
      return post(`${pj(id)}/ai/answer`, {
        answers: list, ...(notes?.length ? { notes } : {}), ...(confirm ? { confirm_extra_project: true } : {}),
      });
    },
    aiChooseType: (id, product_kind, confirm) =>
      post(`${pj(id)}/ai/choose-type`, confirm ? { product_kind, confirm_extra_project: true } : { product_kind }),
    aiChooseObjects: (id, objects, confirm) =>
      post(`${pj(id)}/ai/choose-objects`, confirm ? { objects, confirm_extra_project: true } : { objects }),
    aiEdit: (id, instruction, confirm) => post(`${pj(id)}/ai/edit`, confirm ? { instruction, confirm_extra_project: true } : { instruction }),
    getChat: (id) => get(`${pj(id)}/chat`),
    getPart: (id, n) => get(`${pj(id)}/parts/${n}`),
    aiBudget: (id) => get(`${pj(id)}/ai/budget`),

    listFiles: async (id) => {
      const r = await get<T.FileItem[] | { files: T.FileItem[] }>(`${pj(id)}/files`);
      return Array.isArray(r) ? r : r.files;
    },
    filesInfo: (id) => get(`${pj(id)}/files`),
    downloadFile: async (id, kind) => {
      if (!download) throw new ApiError(0, 'no_downloader', 'download unavailable');
      return download(`${http.baseUrl}${pj(id)}/files/${enc(kind)}`, await http.authHeader(), kind);
    },

    orderPreview: (id, km) => get(`${pj(id)}/orders/preview`, { distance_km: km ?? undefined }),
    createOrder: (id, km) => post(`${pj(id)}/orders`, { distance_km: km ?? null }),
    listOrders: async () => (await get<T.Page<T.OrderOut>>('/orders', { limit: 200 })).items,
    getOrder: (id) => get(`/orders/${enc(id)}`),
    cancelOrder: (id, reason) => post(`/orders/${enc(id)}/cancel`, { reason: reason ?? null }),
    downloadOrderInvoice: async (id) => {
      if (!download) throw new ApiError(0, 'no_downloader', 'download unavailable');
      return download(`${http.baseUrl}/orders/${enc(id)}/invoice`, await http.authHeader(), `invoice_${id}.pdf`);
    },
    resubmitOrder: (id) => post(`/orders/${enc(id)}/resubmit`),
    listOrderMessages: async (id) => items(await get<T.OrderMessage[] | { items: T.OrderMessage[] }>(`/orders/${enc(id)}/messages`)),
    sendOrderMessage: (id, body) => {
      const form = new FormData();
      form.append('text', body.text ?? '');
      appendFiles(form, body.files);
      return http.request(`/orders/${enc(id)}/messages`, { method: 'POST', form });
    },
    markOrderMessagesRead: async (id) => { await post(`/orders/${enc(id)}/messages/read`); },
    listOrderCorrections: async (id) => items(await get<T.OrderCorrection[] | { items: T.OrderCorrection[] }>(`/orders/${enc(id)}/corrections`)),
    approveOrderCorrection: (id, cid) => post(`/orders/${enc(id)}/corrections/${enc(cid)}/approve`),
    declineOrderCorrection: (id, cid, comment) => post(`/orders/${enc(id)}/corrections/${enc(cid)}/decline`, { comment: comment || null }),
    listOrderReturns: async (id) => items(await get<T.OrderReturn[] | { items: T.OrderReturn[] }>(`/orders/${enc(id)}/returns`)),
    createOrderReturn: (id, body) => {
      const form = new FormData();
      form.append('type', body.type);
      form.append('description', body.description);
      if (body.lines?.length) form.append('lines', JSON.stringify(body.lines));
      appendFiles(form, body.files);
      return http.request(`/orders/${enc(id)}/returns`, { method: 'POST', form });
    },
    listOrderDisputes: async (id) => items(await get<T.OrderDispute[] | { items: T.OrderDispute[] }>(`/orders/${enc(id)}/disputes`)),
    openOrderDispute: (id, body) => {
      const form = new FormData();
      form.append('subject', body.subject);
      if (body.return_id) form.append('return_id', body.return_id);
      form.append('reason', body.reason);
      if (body.comment) form.append('comment', body.comment);
      appendFiles(form, body.files);
      return http.request(`/orders/${enc(id)}/disputes`, { method: 'POST', form });
    },

    sendNonstandard: (id, body) => post(`${pj(id)}/nonstandard`, body),
    listNonstandard: (id) => get(`${pj(id)}/nonstandard`),
    acceptNonstandard: (id, rid) => post(`${pj(id)}/nonstandard/${enc(rid)}/accept`),
    downloadNonstandardFile: async (_id, file) => {
      if (!download) throw new ApiError(0, 'no_downloader', 'download unavailable');
      return download(`${http.baseUrl}${file.url}`, await http.authHeader(), file.name);
    },

    registerPushToken: async (token, platform, deviceId) => {
      await post('/devices', { push_token: token, platform, device_id: deviceId ?? null });
      return { stored: 'api' as const };
    },
    unregisterPush: async (deviceId) => { await del(`/devices?device_id=${enc(deviceId)}`); },
    listNotifications: () => get('/notifications'),
    markNotificationRead: async (id) => { await post(`/notifications/${enc(id)}/read`); },
    getNotificationSettings: () => get('/me/notification-settings'),
    updateNotificationSettings: (body) => patch('/me/notification-settings', body),
  };
}
