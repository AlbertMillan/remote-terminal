/**
 * Turn a parked job's question text into something you can decide from.
 *
 * A stage that stops rather than guess writes free prose, and it always has the
 * same shape: one bullet per open question, each leading with the question
 * itself, then the context, then the alternatives it weighed, then what it
 * would do. Rendered verbatim that is a wall of text — the question, the thing
 * you actually have to answer, sits level with everything else.
 *
 * So this pulls those parts out and the board renders each as its own element.
 * It is a parser over prose, not a markdown renderer: the client has never had
 * one and does not gain one here. Inline marks left in the extracted strings
 * are stripped (`stripMarks`), because the structure already says what the
 * emphasis was for.
 *
 * Every rule below degrades to "no match", never to a wrong match: a block with
 * no question stays whole as a plain note, and a detail with no questions at
 * all returns null so the caller can fall back to showing the text as written.
 * Nothing the model wrote is ever dropped.
 *
 * Pure string work, no DOM, so it is covered by tests/decision-format.test.ts.
 */

export interface DecisionOption {
  /** The marker the model used — "a", "b", "1" — shown as the option's bullet. */
  label: string;
  text: string;
}

export interface DecisionRecommendation {
  /** What the model did: suggested a way forward, or already picked a default. */
  kind: 'recommends' | 'assumes';
  /** The option it points at, when it named one. */
  option: string | null;
  text: string;
}

export interface DecisionCard {
  /** Empty when the block was not question-shaped; it is then shown as a note. */
  question: string;
  /** Supporting prose, one entry per paragraph. */
  context: string[];
  options: DecisionOption[];
  recommendation: DecisionRecommendation | null;
}

export interface ParsedDecision {
  /** Anything written before the first question. */
  preamble: string[];
  cards: DecisionCard[];
  /** How many cards actually ask something — the number of answers owed. */
  questionCount: number;
}

/**
 * Drop the model's inline marks.
 *
 * Backticks and `**` go; `_` is left alone because it appears far more often
 * inside identifiers (`MAX_HISTORICAL_DAYS`) than as emphasis, and stripping it
 * would corrupt the very strings that make a question answerable.
 */
export function stripMarks(text: string): string {
  return text
    .replace(/`+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=$|[\s.,;:!?)])/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Split on blank lines, strip each paragraph, drop the empties. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => stripMarks(p.replace(/\n/g, ' ')))
    .filter(Boolean);
}

/**
 * The end of the sentence starting at `from`.
 *
 * A boundary needs whitespace and then something that can open a sentence, so
 * the dots inside `§3.2`, `e.g.` and `0.5` are not mistaken for one.
 */
function sentenceEnd(text: string, from: number): number {
  const re = /[.!?](?=\s+(?:[A-Z(["'*`§]|\d))/g;
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? match.index + 1 : text.length;
}

/**
 * Split the detail into the text before the first question and one entry per
 * top-level list item.
 *
 * Only an item indented 3 spaces or less starts a new question — deeper ones
 * are the model laying out alternatives, and belong to the item above. Hard
 * wraps inside an item are joined back up; blank lines survive as paragraphs,
 * so the model's own wrapping stops dictating the column width.
 */
function splitBlocks(detail: string): { preamble: string; blocks: string[] } {
  const lines = detail.replace(/\r\n?/g, '\n').split('\n');
  const preamble: string[] = [];
  const blocks: string[][] = [];
  let current: string[] | null = null;

  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const item = indent <= 3 ? /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(raw.trim()) : null;
    if (item) {
      current = [item[1].trim()];
      blocks.push(current);
      continue;
    }
    const target = current ?? preamble;
    const text = raw.trim();
    if (!text) {
      if (target.length > 0) target.push('');
      continue;
    }
    target.push(text);
  }

  // A run of lines is one paragraph; the blank markers between runs are kept.
  const join = (parts: string[]): string =>
    parts
      .reduce<string[]>((acc, part) => {
        if (part === '') acc.push('');
        else if (acc.length === 0 || acc[acc.length - 1] === '') acc.push(part);
        else acc[acc.length - 1] += ` ${part}`;
        return acc;
      }, [])
      .filter(Boolean)
      .join('\n\n');

  return { preamble: join(preamble), blocks: blocks.map(join).filter(Boolean) };
}

/** The question a block opens with: a bold lead, else its first question mark. */
function splitQuestion(text: string): { question: string; rest: string } | null {
  const bold = /^\*\*([^*]+)\*\*\s*:?\s*/.exec(text);
  if (bold && bold[1].trim().length >= 8) {
    return { question: stripMarks(bold[1]), rest: text.slice(bold[0].length).trim() };
  }
  const mark = text.indexOf('?');
  // Past a few hundred characters it is prose that happens to contain a
  // question mark, not a heading, and promoting it would bury the point.
  if (mark >= 0 && mark <= 400) {
    return { question: stripMarks(text.slice(0, mark + 1)), rest: text.slice(mark + 1).trim() };
  }
  return null;
}

/** Where the model says what it would do, and whether it had already assumed it. */
function findRecommendation(rest: string): { start: number; end: number; rec: DecisionRecommendation } | null {
  const re =
    /(?:^|[\s.;:,—–-])(\*\*\s*)?((?:I\s+(?:would\s+)?)?recommend(?:ation|s|ed)?\b|I(?:'ve|\s+have)?\s+assum(?:e|ed)\b|(?:my\s+)?default\s+(?:is|would\s+be)\b)/i;
  const match = re.exec(rest);
  if (!match) return null;

  const keyword = match[2];
  const start = match.index + match[0].length - keyword.length - (match[1] ? match[1].length : 0);
  const end = sentenceEnd(rest, start);
  const body = rest.slice(start, end);
  const option = /\(([a-z])\)/i.exec(body);
  const kind = /assum|default/i.test(keyword) ? 'assumes' : 'recommends';

  // "Recommend (b): a single seeded…" — the lead-in becomes the callout's own
  // label, so repeating it in the body is noise. Only ever dropped when the
  // option was captured: "I have assumed stop" carries the decision in that
  // lead-in, and cutting it would throw away the answer itself.
  let text = stripMarks(body);
  if (kind === 'recommends' && option) {
    text = text.replace(
      /^(?:I\s+(?:would\s+)?)?recommend(?:ation|s|ed)?\b\s*\([a-z]\)\s*[:\-—–]?\s*/i,
      ''
    );
  }

  return { start, end, rec: { kind, option: option ? option[1].toLowerCase() : null, text } };
}

/**
 * The alternatives, when the model laid them out as (a)/(b)/(c).
 *
 * Two markers running in order from "a" is the bar: a lone "(a)" in prose is
 * not a list, and markers out of order mean something else is going on.
 */
function findOptions(
  rest: string,
  limit: number
): { start: number; end: number; options: DecisionOption[] } | null {
  const re = /\(([a-z])\)\s*/g;
  const hits: Array<{ index: number; after: number; label: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(rest)) !== null) {
    if (match.index >= limit) break;
    hits.push({ index: match.index, after: match.index + match[0].length, label: match[1].toLowerCase() });
  }
  const wanted = 'abcdefghijklmnopqrstuvwxyz';
  if (hits.length < 2 || !hits.every((hit, i) => hit.label === wanted[i])) return null;

  const options = hits.map((hit, i) => ({
    label: hit.label,
    text: stripMarks(rest.slice(hit.after, i + 1 < hits.length ? hits[i + 1].index : limit)).replace(
      /[;,.\s]+$/,
      ''
    ),
  }));
  return { start: hits[0].index, end: limit, options: options.filter((o) => o.text) };
}

/** Everything outside the spans already claimed by options and recommendation. */
function remainingContext(rest: string, cuts: Array<[number, number]>): string[] {
  const ordered = [...cuts].sort((a, b) => a[0] - b[0]);
  let at = 0;
  const kept: string[] = [];
  for (const [start, end] of ordered) {
    if (start > at) kept.push(rest.slice(at, start));
    at = Math.max(at, end);
  }
  kept.push(rest.slice(at));
  return kept
    .join('\n\n')
    .split(/\n{2,}/)
    // The label introducing the options goes with them, not with the context.
    .map((part) => part.replace(/(?:the\s+)?(?:options?|alternatives?)(?:\s+are|\s+include)?\s*:?\s*$/i, ''))
    .map((part) => stripMarks(part).replace(/^[\s;,.—–-]+/, '').trim())
    .filter(Boolean);
}

function parseBlock(text: string): DecisionCard {
  const split = splitQuestion(text);
  if (!split) return { question: '', context: paragraphs(text), options: [], recommendation: null };

  const { question, rest } = split;
  const cuts: Array<[number, number]> = [];

  const recommendation = findRecommendation(rest);
  if (recommendation) cuts.push([recommendation.start, recommendation.end]);

  // Options are looked for only ahead of the recommendation: the recommendation
  // names one, and that mention is not the start of a second list.
  const options = findOptions(rest, recommendation ? recommendation.start : rest.length);
  if (options) cuts.push([options.start, options.end]);

  return {
    question,
    context: remainingContext(rest, cuts),
    options: options ? options.options : [],
    recommendation: recommendation ? recommendation.rec : null,
  };
}

/**
 * Parse a parked job's detail. Returns null when nothing in it is a question,
 * which is the caller's signal to show the text as the model wrote it.
 */
export function parseDecision(detail: string): ParsedDecision | null {
  const trimmed = (detail || '').trim();
  if (!trimmed) return null;

  const { preamble, blocks } = splitBlocks(trimmed);
  // With no list at all the whole detail is the one question, and there is no
  // preamble left over — otherwise it would be rendered twice.
  const listed = blocks.length > 0;
  const cards = (listed ? blocks : [preamble]).map(parseBlock);
  const questionCount = cards.filter((card) => card.question).length;
  if (questionCount === 0) return null;

  return { preamble: listed ? paragraphs(preamble) : [], cards, questionCount };
}
