import { html, type SafeHtml } from './html-utils.js';
import { requestJson, failureMessage } from './api.js';
import type { FactoryBoardUnit } from '../shared/protocol.js';

/**
 * The mockup drawer of the factory board (project/code-factory.md, "mockup
 * first inserts a mockup step that parks for approval"): for an item parked at
 * the `mockup` step, the agent's clickable mockup in a sandboxed frame with its
 * walkthrough, and the three things you do with it:
 *
 * - **Approve**: the release route with `approved`; the item goes on to
 *   implement, which follows the mockup.
 * - **Comment**: POST …/mockup/comment; the same mockup session revises it and
 *   it parks here again, up to its revision cap.
 * - **Open full size**: the page in its own tab, served with the same sandbox.
 *
 * Data: GET /api/factory/mockup (server factory/mockup-routes.ts), fetched
 * when the drawer shows a unit and again whenever the unit changed. The board
 * (factory-board.ts) owns rendering, drafts and the busy state; this module
 * only renders its part and handles the `mockup-*` actions.
 */

export interface MockupInfo {
  featureId: string;
  url: string | null;
  walkthrough: string | null;
  revisions: number;
  maxRevisions: number;
  waiting: boolean;
  approved: boolean;
}

type ActCall = () => Promise<{ ok: boolean; status: number; data: { error?: string } }>;

export interface MockupDrawerHost {
  render(): void;
  act(label: string, call: ActCall, done?: () => void): Promise<void>;
  post(url: string, body: object): ReturnType<ActCall>;
  busy(): boolean;
  /** The draft under `key` (captured from the DOM first), and forgetting it. */
  draft(key: string): string;
  clearDraft(key: string): void;
  notify(text: string): void;
  markdown(text: string): SafeHtml;
}

/** The unit waits on its mockup: a loose item parked at the `mockup` step. */
export function isMockupPark(u: FactoryBoardUnit): boolean {
  return !u.isTrack && u.status === 'parked' && u.step === 'mockup';
}

/** The frame's address: a revision is a new URL, so the frame never shows a stale page. */
export function frameSrc(info: MockupInfo): string | null {
  return info.url ? `${info.url}?r=${info.revisions}` : null;
}

export class MockupDrawer {
  /** By unit key, for the unit's `updatedAt` it was loaded at. */
  private info = new Map<string, { at: string; info: MockupInfo | null; error: string | null }>();
  private loading = new Set<string>();

  constructor(private readonly host: MockupDrawerHost) {}

  private async load(u: FactoryBoardUnit): Promise<void> {
    if (this.loading.has(u.key)) return;
    this.loading.add(u.key);
    try {
      const res = await requestJson<MockupInfo>(
        `/api/factory/mockup?cwd=${encodeURIComponent(u.projectCwd)}&unit=${encodeURIComponent(u.featureIds[0])}`
      );
      this.info.set(u.key, {
        at: u.updatedAt,
        info: res.ok ? res.data : null,
        error: res.ok ? null : failureMessage(res, 'Could not load the mockup'),
      });
    } finally {
      this.loading.delete(u.key);
    }
    this.host.render();
  }

  render(u: FactoryBoardUnit): SafeHtml {
    const cached = this.info.get(u.key);
    if (!cached || cached.at !== u.updatedAt) void this.load(u);
    const busy = this.host.busy();
    if (!cached) return html`<div class="fb-verdict"><b>Mockup</b>: loading…</div>`;
    if (!cached.info) return html`<div class="fb-verdict"><b>Mockup</b>: ${cached.error ?? 'unavailable'}</div>`;
    const info = cached.info;
    const src = frameSrc(info);
    if (!src) {
      // The run wrote no page: the park reason says why; another round builds one.
      return html`<div class="fb-verdict"><b>No mockup yet</b></div>
        ${u.detail.parkReason && html`<pre class="fb-pre">${u.detail.parkReason}</pre>`}
        <div class="fb-acts"><button type="button" class="btn-primary" data-fb="release" ${busy ? 'disabled' : ''}>Build it again</button></div>`;
    }
    const capped = info.revisions >= info.maxRevisions;
    const key = `mockup:${u.key}`;
    return html`<div class="fb-verdict"><b>${capped ? 'Mockup escalated to you' : 'Mockup waiting for your approval'}</b>${info.revisions > 0
        ? html` · revision ${info.revisions} of ${info.maxRevisions}`
        : ''}${capped ? html`: no more revisions; approve it as it stands, or cancel the item` : ''}</div>
      <iframe class="fb-mockup-frame" sandbox="allow-scripts" referrerpolicy="no-referrer" title="Mockup of ${u.title}" src="${src}"></iframe>
      <div class="fb-acts">
        <button type="button" class="btn-primary" data-fb="mockup-approve" ${busy || !info.waiting ? 'disabled' : ''}>Approve</button>
        <a class="btn-secondary" href="${src}" target="_blank" rel="noopener noreferrer" data-mockup-open>Open full size</a>
      </div>
      ${info.walkthrough && html`<h4>What you'd do</h4><div class="fb-md">${this.host.markdown(info.walkthrough)}</div>`}
      ${!capped && html`<h4>Comment <span class="fb-path">(${info.maxRevisions - info.revisions} revision${info.maxRevisions - info.revisions === 1 ? '' : 's'} left)</span></h4>
        <textarea class="fb-textarea" rows="4" data-draft="${key}" placeholder="What should the mockup change? The same agent revises it.">${this.host.draft(key)}</textarea>
        <div class="fb-acts"><button type="button" class="btn-secondary" data-fb="mockup-comment" ${busy || !info.waiting ? 'disabled' : ''}>Send comment</button></div>`}`;
  }

  async onAction(kind: string, u: FactoryBoardUnit | undefined): Promise<void> {
    if (!u) return;
    const featureId = u.featureIds[0];
    if (kind === 'mockup-approve') {
      return this.host.act('Mockup approved: it goes on to implement', () =>
        this.host.post(`/api/factory/items/${featureId}/release`, { cwd: u.projectCwd, outcome: 'approved' })
      );
    }
    if (kind === 'mockup-comment') {
      const key = `mockup:${u.key}`;
      const text = this.host.draft(key).trim();
      if (!text) {
        this.host.notify('Say what the mockup should change first.');
        return;
      }
      return this.host.act(
        'Sent to the mockup agent: it parks here again once revised',
        () => this.host.post(`/api/factory/items/${featureId}/mockup/comment`, { cwd: u.projectCwd, text }),
        () => {
          this.host.clearDraft(key);
          this.info.delete(u.key);
        }
      );
    }
  }
}
