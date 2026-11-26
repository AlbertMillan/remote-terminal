/**
 * The JSON object an agent's reply consists of, or null. Strict, as the
 * reviewer's verdict (review-step.ts): the reply is the object alone, or ends
 * with it as its last fenced ```json block. A sample quoted mid-reply is not
 * the answer, and nothing is ever guessed from prose.
 */
export function jsonReply(text: string): unknown {
  const trimmed = text.trim();
  const parse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  if (trimmed.startsWith('{')) return parse(trimmed);
  const fences = [...trimmed.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const last = fences[fences.length - 1];
  if (!last || last.index + last[0].length !== trimmed.length) return null;
  return parse(last[1]);
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
