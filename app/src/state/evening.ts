/** «Вечер» в редакторе после «Применить» на экране подсветки (SCR-49 → SCR-08e): флаг по проекту, читается один раз. */
const pending = new Set<string>();
export const requestEvening = (projectId: string) => { pending.add(projectId); };
export const takeEvening = (projectId: string) => pending.delete(projectId);
