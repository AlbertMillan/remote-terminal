import { setHtml, type SafeHtml } from './html-utils.js';

export interface OpenDialog<T> {
  modal: HTMLElement;
  /** Remove the dialog and settle `closed` with `result`. Later calls do nothing. */
  close: (result: T) => void;
  /** Settles once, with what `close` was given; Escape and `[data-cancel]` give `cancelValue`. */
  closed: Promise<T>;
}

/**
 * Mount a `div.modal` holding `content` and wire the ways out: Escape and any
 * `[data-cancel]` button close it with `cancelValue`. The caller wires its own
 * confirm and calls `close()` with the result.
 */
export function openDialog<T>(className: string, content: SafeHtml, cancelValue: T): OpenDialog<T> {
  const modal = document.createElement('div');
  modal.className = `modal ${className}`;
  setHtml(modal, content);
  document.body.appendChild(modal);

  let settle!: (result: T) => void;
  const closed = new Promise<T>((resolve) => {
    settle = resolve;
  });
  let open = true;
  const close = (result: T): void => {
    if (!open) return;
    open = false;
    modal.remove();
    document.removeEventListener('keydown', onKey);
    settle(result);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close(cancelValue);
  };
  document.addEventListener('keydown', onKey);
  for (const button of modal.querySelectorAll('[data-cancel]')) {
    button.addEventListener('click', () => close(cancelValue));
  }
  return { modal, close, closed };
}
