/**
 * Building markup from data. The client renders by template string into `innerHTML`, and a
 * page with a shell behind it can't afford one forgotten escape: text from git, PROJECT.md,
 * a terminal or another tailnet device would run as script.
 *
 * So markup is a type. `html` escapes every interpolation unless it is already `SafeHtml`
 * (another `html` result, or `raw()` for trusted constants such as icons), and `setHtml` is
 * the one sink, taking `SafeHtml` only. ESLint refuses a direct `innerHTML` write anywhere
 * else (eslint.config.js). A value forgotten in the wrong form shows up as escaped text on
 * screen, never as markup.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

/** Escapes text for element content **and** quoted attributes alike. */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Same as escapeHtml; kept so attribute call sites read as what they are. */
export const escapeAttr = escapeHtml;

/** Markup already built safely. Only `html` and `raw` make one. */
export class SafeHtml {
  /** @internal Use `html` or `raw`. */
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/**
 * What a template may interpolate: `false` (so `${cond && html`…`}` works) but never `true`
 * or `boolean`. A bare flag such as `aria-expanded="${open}"` would render nothing and drop
 * the attribute's value, so the compiler refuses it: write `${String(open)}`.
 */
export type HtmlValue = SafeHtml | string | number | false | null | undefined | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

/**
 * A template whose interpolations are escaped. Arrays are joined (so `${items.map(...)}`
 * needs no `.join('')`), and `null`/`undefined`/`false` render nothing, so
 * `${cond && html`…`}` works.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Trusted markup as is: constants written in this codebase (icons), never data. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** Joins fragments, escaping any plain string among them. */
export function joinHtml(parts: readonly HtmlValue[], separator: SafeHtml | string = ''): SafeHtml {
  const sep = render(separator);
  return new SafeHtml(parts.map(render).join(sep));
}

/** The one markup sink. */
export function setHtml(el: Element, markup: SafeHtml): void {
  // eslint-disable-next-line no-restricted-syntax -- the sink itself
  el.innerHTML = markup.value;
}

/** Like `insertAdjacentHTML`, for `SafeHtml` only. */
export function insertHtml(el: Element, position: InsertPosition, markup: SafeHtml): void {
  // eslint-disable-next-line no-restricted-syntax -- the sink itself
  el.insertAdjacentHTML(position, markup.value);
}
