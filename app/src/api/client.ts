/** Интерфейс API приложения: одна форма для настоящего сервера и для мока. */
import type * as T from './types';

export interface UploadFile { uri: string; name: string; type: string }
export interface DownloadedFile { uri: string; mimeType: string; name: string }
export interface ProjectQuery { status?: T.ProjectStatus[]; q?: string; client_id?: string; archived?: boolean; limit?: number; offset?: number }

export interface Api {
  readonly mode: 'http' | 'mock';
  // auth
  requestCode(phone: string, channel?: 'sms' | 'telegram'): Promise<T.RequestCodeOut>;
  verifyCode(body: T.VerifyCodeIn): Promise<T.TokensOut>;
  me(): Promise<T.UserOut>;
  updateMe(body: { name?: string; language?: T.Lang }): Promise<T.UserOut>;
  logout(refreshToken: string): Promise<void>;
  // приглашение в цех (SCR-38a)
  myInvite(): Promise<T.InviteOut | null>;
  acceptInvite(id: string): Promise<T.TokensOut>;
  declineInvite(id: string): Promise<void>;
  // удаление аккаунта (SCR-44)
  requestDeleteCode(channel?: 'sms' | 'telegram'): Promise<T.RequestCodeOut>;
  deleteAccount(code: string): Promise<T.DeleteAccountOut>;
  // версия приложения и техработы (SCR-45), без входа
  appStatus(platform: 'ios' | 'android' | 'web', version: string): Promise<T.AppStatusOut>;
  // workshop
  getWorkshop(): Promise<T.WorkshopOut>;
  updateWorkshop(body: T.WorkshopUpdateIn): Promise<T.WorkshopOut>;
  getPricing(): Promise<T.PricingOut>;
  updatePricing(body: Partial<T.PricingOut>): Promise<T.PricingOut>;
  listEmployees(): Promise<T.EmployeeOut[]>;
  /** Теперь создаёт приглашение (как inviteEmployee). */
  addEmployee(phone: string, name: string): Promise<T.InviteOut>;
  inviteEmployee(body: T.InviteIn): Promise<T.InviteOut>;
  listInvites(): Promise<T.InviteOut[]>;
  resendInvite(id: string): Promise<T.InviteOut>;
  cancelInvite(id: string): Promise<void>;
  updateEmployee(id: string, body: T.EmployeeUpdateIn): Promise<T.EmployeeOut>;
  removeEmployee(id: string): Promise<void>;
  limits(): Promise<T.LimitsOut>;
  /** Логотип цеха (POST/DELETE /workshops/me/logo): JPEG/PNG/WebP до 2 МБ. */
  uploadLogo(file: UploadFile): Promise<T.WorkshopOut>;
  deleteLogo(): Promise<T.WorkshopOut>;
  /** Платежи платформе: пакеты, Pro, файлы, возвраты (SCR-42, владелец). */
  listPayments(): Promise<T.PaymentOut[]>;
  // clients
  listClients(q?: string): Promise<T.Page<T.ClientOut>>;
  createClient(body: T.ClientIn): Promise<T.ClientOut>;
  getClient(id: string): Promise<T.ClientCardOut>;
  updateClient(id: string, body: Partial<T.ClientIn>): Promise<T.ClientOut>;
  // projects
  listProjects(q?: ProjectQuery): Promise<T.Page<T.ProjectListItem>>;
  createProject(body: T.ProjectIn): Promise<T.ProjectCardOut>;
  /**
   * «Попробовать на примере» (POST /projects/example): сервер создаёт пример из своего шаблона (201) или отдаёт
   * действующий пример цеха (200). Примеров за всё время — не больше 3: дальше `409 example_limit`.
   */
  createExample(): Promise<T.ProjectCardOut>;
  getProject(id: string): Promise<T.ProjectCardOut>;
  updateProject(id: string, body: Partial<T.ProjectIn>): Promise<T.ProjectCardOut>;
  deleteProject(id: string): Promise<void>;
  archiveProject(id: string): Promise<T.ProjectCardOut>;
  unarchiveProject(id: string): Promise<T.ProjectCardOut>;
  /** Копия «… (копия)»: тот же клиент, дерево текущей версии; лимит — при переходе в эскиз. */
  duplicateProject(id: string): Promise<T.ProjectCardOut>;
  uploadPhoto(projectId: string, file: UploadFile, kind?: T.PhotoOut['kind']): Promise<T.PhotoOut>;
  deletePhoto(projectId: string, photoId: string): Promise<void>;
  // статусы
  toSketch(id: string): Promise<T.ProjectCardOut>;
  addMeasurement(id: string, body: T.MeasurementIn): Promise<T.MeasurementOut>;
  listMeasurements(id: string): Promise<T.MeasurementOut[]>;
  toContract(id: string): Promise<T.ProjectCardOut>;
  deliver(id: string, materialsSelfBought: boolean): Promise<T.ProjectCardOut>;
  cancelProject(id: string, reason?: string): Promise<T.ProjectCardOut>;
  // модель
  getModel(projectId: string): Promise<T.ModelStateOut>;
  saveModel(projectId: string, body: T.ModelIn): Promise<T.ModelStateOut>;
  undo(projectId: string): Promise<T.ModelStateOut>;
  redo(projectId: string): Promise<T.ModelStateOut>;
  applyFix(projectId: string, issueIndex: number, fixIndex: number): Promise<T.ModelStateOut>;
  listVersions(projectId: string): Promise<T.VersionBrief[]>;
  getVersion(projectId: string, versionId: string): Promise<T.VersionOut>;
  restoreVersion(projectId: string, versionId: string): Promise<T.ModelStateOut>;
  /** Снять «оценку» с путей (на сервере — видно на всех телефонах). */
  confirmEstimated(projectId: string, versionId: string, pointers: string[]): Promise<{ version_id: string; estimated: string[] }>;
  // фурнитура (SCR-26)
  getHardware(projectId: string): Promise<T.HardwareOut>;
  applyHardware(projectId: string, key: string, value: string): Promise<T.ModelStateOut>;
  // смета
  getEstimate(projectId: string): Promise<T.ProjectEstimate>;
  getClientEstimate(projectId: string, view?: T.EstimateView): Promise<T.ClientEstimate>;
  getNesting(projectId: string): Promise<T.NestingOut>;
  listPriceRequests(projectId: string): Promise<T.PriceRequestOut[]>;
  decidePriceRequest(projectId: string, requestId: string, accept: boolean): Promise<T.PriceRequestOut>;
  listDecors(): Promise<T.DecorOut[]>;
  /** Каталог декоров с фильтрами и фасетами (бренды, семейства цвета). */
  searchDecors(query?: T.DecorQuery): Promise<T.DecorList>;
  listPaintColors(): Promise<T.PaintPalette>;
  /** Варианты декора фасадов, подсветки и встройки (GET /catalog/front-styles, lighting-zones, builtin-options). */
  getFrontStyles(): Promise<T.FrontStylesOut>;
  getLightingZones(): Promise<T.LightingZonesOut>;
  getBuiltinOptions(): Promise<T.BuiltinOptionsOut>;
  // ссылка клиента
  createShareLink(projectId: string, body: T.ShareLinkIn): Promise<T.ShareLinkOut>;
  listShareLinks(projectId: string): Promise<T.ShareLinkOut[]>;
  // задачи и ИИ
  getTask<R = unknown>(taskId: string): Promise<T.TaskOut<R>>;
  aiDesign(projectId: string, body: T.DesignIn): Promise<T.TaskAccepted>;
  /** Все ответы раунда разом (на сервер — [{question_id, value}]); «не знаю» — по умолчанию. */
  /** Все ответы раунда и свободные замечания мастера (`notes`) — одним запросом. */
  aiAnswer(projectId: string, answers: Record<string, string>, confirmExtra?: boolean, notes?: string[]): Promise<T.TaskAccepted>;
  aiChooseType(projectId: string, productKind: string, confirmExtra?: boolean): Promise<T.TaskAccepted>;
  /** Номера в DesignOut.objects; первый остаётся в проекте, остальные — новые проекты (лимит за каждый). */
  aiChooseObjects(projectId: string, objects: number[], confirmExtra?: boolean): Promise<T.ChooseObjectsOut>;
  aiEdit(projectId: string, instruction: string, confirmExtra?: boolean): Promise<T.TaskAccepted>;
  getChat(projectId: string): Promise<T.ChatOut>;
  /** Деталь текущей версии по номеру (SCR-25). */
  getPart(projectId: string, number: number): Promise<T.PartOut>;
  /** Бюджет ИИ-правок проекта (SCR-08: «ИИ-правок ~20%»). */
  aiBudget(projectId: string): Promise<T.AiBudgetOut>;
  // файлы
  listFiles(projectId: string): Promise<T.FileItem[]>;
  /** Весь ответ списка файлов: доступ и цена «Скачать без заказа». */
  filesInfo(projectId: string): Promise<T.FilesOut>;
  downloadFile(projectId: string, kind: T.FileKind): Promise<DownloadedFile>;
  // заказы (SCR-14/15/16/31)
  orderPreview(projectId: string, distanceKm?: number | null): Promise<T.OrderPreview>;
  createOrder(projectId: string, distanceKm?: number | null): Promise<T.OrderOut>;
  listOrders(): Promise<T.OrderOut[]>;
  getOrder(id: string): Promise<T.OrderOut>;
  cancelOrder(id: string, reason?: string): Promise<T.OrderOut>;
  /** «Счёт EMAN · PDF» по заказу. */
  downloadOrderInvoice(id: string): Promise<DownloadedFile>;
  /** Повторная отправка после returned (§5.6): берёт текущую версию проекта, заказ снова created. */
  resubmitOrder(id: string): Promise<T.OrderOut>;
  // переписка с поставщиком (§5.6)
  listOrderMessages(id: string): Promise<T.OrderMessage[]>;
  sendOrderMessage(id: string, body: T.OrderMessageIn): Promise<T.OrderMessage>;
  markOrderMessagesRead(id: string): Promise<void>;
  // исправления поставщика (§5.6)
  listOrderCorrections(id: string): Promise<T.OrderCorrection[]>;
  approveOrderCorrection(id: string, correctionId: string): Promise<T.OrderOut>;
  declineOrderCorrection(id: string, correctionId: string, comment?: string | null): Promise<T.OrderOut>;
  // рекламации и споры (§5.6, §4a)
  listOrderReturns(id: string): Promise<T.OrderReturn[]>;
  createOrderReturn(id: string, body: T.OrderReturnIn): Promise<T.OrderReturn>;
  listOrderDisputes(id: string): Promise<T.OrderDispute[]>;
  openOrderDispute(id: string, body: T.OrderDisputeIn): Promise<T.OrderDispute>;
  // нестандарт (SCR-19, SCR-34)
  sendNonstandard(projectId: string, body: T.NonstandardIn): Promise<T.NonstandardOut>;
  listNonstandard(projectId: string): Promise<T.NonstandardOut[]>;
  acceptNonstandard(projectId: string, requestId: string): Promise<T.NonstandardOut>;
  downloadNonstandardFile(projectId: string, file: T.NonstandardFile): Promise<DownloadedFile>;
  // push
  registerPushToken(token: string, platform: 'ios' | 'android', deviceId?: string | null): Promise<{ stored: 'api' | 'local' }>;
  unregisterPush(deviceId: string): Promise<void>;
  // уведомления (Notifications.dc.html)
  listNotifications(): Promise<T.NotificationOut[]>;
  markNotificationRead(id: string): Promise<void>;
  // настройки уведомлений (FR-66, Misc.dc.html)
  getNotificationSettings(): Promise<T.NotificationSettingsOut>;
  updateNotificationSettings(body: T.NotificationSettingsIn): Promise<T.NotificationSettingsOut>;
}
