/**
 * Разбор переписки с ИИ для шторки чата (как в редакторе шкафа, SCR-08): последняя правка с версией — карточкой
 * с «Отменить»; хвост из вопросов ИИ — блоком с вариантами (вопросы распознавания с id отвечаются разом через
 * /ai/answer, вопрос правки — один, тап по варианту отправляет его текстом); остальное — история.
 */
import type { ChatMessage, DesignQuestion } from '../api/types';

export type ChatView = {
  history: ChatMessage[];
  lastChange: ChatMessage | null;
  /** Вопросы распознавания без ответа, на которые ИИ ждёт ответ сейчас. */
  designQs: DesignQuestion[];
  /** Вопрос правки с вариантами (последнее сообщение ИИ). */
  question: ChatMessage | null;
};

export function chatView(messages: ChatMessage[], questions: DesignQuestion[] = []): ChatView {
  const lastChangeIdx = messages.map((m) => !!m.version_id && m.author === 'ai').lastIndexOf(true);
  const lastChange = lastChangeIdx >= 0 ? messages[lastChangeIdx] : null;
  const lastMsg = messages[messages.length - 1];
  const tail: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].author === 'ai' && messages[i].kind === 'question'; i--) tail.unshift(messages[i]);
  const tailTexts = new Set(tail.map((m) => m.text));
  const designQs = questions.filter((q) => tailTexts.has(q.text));
  const question = !designQs.length && lastMsg && lastMsg.author === 'ai' && lastMsg.options?.length ? lastMsg : null;
  const inCard = new Set<ChatMessage>([...(designQs.length ? tail.filter((m) => designQs.some((q) => q.text === m.text)) : []), ...(question ? [question] : [])]);
  return { history: messages.filter((m) => m !== lastChange && !inCard.has(m)), lastChange, designQs, question };
}
