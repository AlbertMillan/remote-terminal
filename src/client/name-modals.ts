import type { CategoryInfo } from './session-types.js';

/** The two one-field dialogs in index.html: rename a session, create or rename a category. */

export class RenameModal {
  private sessionId: string | null = null;

  constructor(private readonly rename: (sessionId: string, name: string) => void) {}

  bind(): void {
    document.getElementById('rename-cancel')?.addEventListener('click', () => this.hide());
    document.getElementById('rename-confirm')?.addEventListener('click', () => this.confirm());
    document.getElementById('rename-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirm();
    });
    document.getElementById('rename-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hide();
    });
  }

  show(sessionId: string, currentName: string): void {
    const modal = document.getElementById('rename-modal');
    const input = document.getElementById('rename-input') as HTMLInputElement | null;
    if (!modal || !input) return;
    this.sessionId = sessionId;
    modal.classList.remove('hidden');
    input.value = currentName;
    input.focus();
    input.select();
  }

  hide(): void {
    document.getElementById('rename-modal')?.classList.add('hidden');
    this.sessionId = null;
  }

  private confirm(): void {
    const input = document.getElementById('rename-input') as HTMLInputElement | null;
    const name = input?.value.trim();
    if (this.sessionId && name) this.rename(this.sessionId, name);
    this.hide();
  }
}

export class CategoryModal {
  private mode: 'create' | 'rename' = 'create';
  private categoryId: string | null = null;

  constructor(
    private readonly actions: {
      create(name: string): void;
      rename(categoryId: string, name: string): void;
    }
  ) {}

  bind(): void {
    document.getElementById('category-cancel')?.addEventListener('click', () => this.hide());
    document.getElementById('category-confirm')?.addEventListener('click', () => this.confirm());
    document.getElementById('category-name-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.confirm();
    });
    document.getElementById('category-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.hide();
    });
  }

  show(mode: 'create' | 'rename', category?: CategoryInfo): void {
    this.mode = mode;
    this.categoryId = category?.id || null;
    const modal = document.getElementById('category-modal');
    const title = document.getElementById('category-modal-title');
    const input = document.getElementById('category-name-input') as HTMLInputElement | null;
    if (modal && title && input) {
      modal.classList.remove('hidden');
      title.textContent = mode === 'create' ? 'Create Category' : 'Rename Category';
      input.value = category?.name || '';
      input.focus();
      input.select();
    }
  }

  hide(): void {
    document.getElementById('category-modal')?.classList.add('hidden');
    this.categoryId = null;
  }

  private confirm(): void {
    const input = document.getElementById('category-name-input') as HTMLInputElement | null;
    const name = input?.value.trim();
    if (!name) return;
    if (this.mode === 'create') this.actions.create(name);
    else if (this.mode === 'rename' && this.categoryId) this.actions.rename(this.categoryId, name);
    this.hide();
  }
}
