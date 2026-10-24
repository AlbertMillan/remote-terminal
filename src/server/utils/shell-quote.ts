/**
 * What may go inside a double-quoted argument of a command the server types into a session's
 * shell (`injectCommand()`). That shell may be cmd, PowerShell or bash, so the rules are the
 * union of theirs. A value that fails is refused or left out, never escaped: a broken quote
 * would run the rest of the line as shell.
 */

/** Characters a double-quoted path does not survive in cmd (`%`), PowerShell (`$`, backtick) or any shell (`"`). */
export const UNSAFE_IN_QUOTES = /["%$`]/;

// Free text (a session name) adds `!` (bash history expansion inside double quotes) and a
// backslash (escapes the closing quote in bash). Paths are typed with forward slashes, so a
// backslash never reaches them.
const UNSAFE_IN_QUOTED_TEXT = /["%$`!\\]/;
const hasControlChar = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** Whether free text can be typed as one double-quoted argument. */
export function isSafeQuotedText(s: string): boolean {
  return !UNSAFE_IN_QUOTED_TEXT.test(s) && !hasControlChar(s);
}
