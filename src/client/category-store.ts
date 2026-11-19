import type { CategoryInfo, ServerMessage } from './session-types.js';

export interface CategoryStoreHost {
  send(type: string, payload?: unknown): string;
  /** Redraw what shows categories (the session list). */
  render(): void;
}

/**
 * The sidebar's categories: the client's copy, the `category.*` messages that
 * change it, and the commands that ask the server to. `categories` is the one
 * map, shared with the session list that draws it.
 */
export class CategoryStore {
  readonly categories = new Map<string, CategoryInfo>();

  constructor(private readonly host: CategoryStoreHost) {}

  /** Apply a `category.*` message and redraw; false for any other message. */
  handleMessage(message: ServerMessage): boolean {
    switch (message.type) {
      case 'category.list':
        this.categories.clear();
        for (const category of message.payload.categories) this.categories.set(category.id, category);
        break;
      case 'category.created':
        this.categories.set(message.payload.category.id, message.payload.category);
        break;
      case 'category.renamed': {
        const category = this.categories.get(message.payload.categoryId);
        if (category) category.name = message.payload.name;
        break;
      }
      case 'category.deleted':
        this.categories.delete(message.payload.categoryId);
        break;
      case 'category.reordered':
        for (const { id, sortOrder } of message.payload.categories) {
          const category = this.categories.get(id);
          if (category) category.sortOrder = sortOrder;
        }
        break;
      case 'category.toggled': {
        const category = this.categories.get(message.payload.categoryId);
        if (category) category.collapsed = message.payload.collapsed;
        break;
      }
      default:
        return false;
    }
    this.host.render();
    return true;
  }

  list(): void {
    this.host.send('category.list');
  }

  create(name: string): void {
    this.host.send('category.create', { name });
  }

  rename(categoryId: string, name: string): void {
    this.host.send('category.rename', { categoryId, name });
  }

  remove(categoryId: string): void {
    this.host.send('category.delete', { categoryId });
  }

  toggle(categoryId: string, collapsed: boolean): void {
    this.host.send('category.toggle', { categoryId, collapsed });
  }
}
