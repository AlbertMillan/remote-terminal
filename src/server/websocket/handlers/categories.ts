import { randomUUID } from 'crypto';
import {
  createMessage,
  type ClientMessage,
  type CategoryCreatePayload,
  type CategoryRenamePayload,
  type CategoryDeletePayload,
  type CategoryReorderPayload,
  type CategoryTogglePayload,
} from '../protocol.js';
import {
  insertCategory,
  updateCategory,
  deleteCategory as deleteCategoryFromDb,
  getAllCategories,
  reorderCategories,
  getCategory,
} from '../../db/queries.js';
import { type ClientConnection, categoryToInfo, broadcastCategoryUpdate } from '../connections.js';

// Category handlers

export function handleCategoryList(connection: ClientConnection, message: ClientMessage): void {
  const categories = getAllCategories(connection.identity?.userId).map(categoryToInfo);
  connection.ws.send(createMessage('category.list', { categories }, message.id));
}

export function handleCategoryCreate(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryCreatePayload;

  if (!payload?.name || typeof payload.name !== 'string') {
    connection.ws.send(createMessage('error', { message: 'Category name required' }, message.id));
    return;
  }

  const name = payload.name.trim().slice(0, 100);
  if (!name) {
    connection.ws.send(createMessage('error', { message: 'Category name cannot be empty' }, message.id));
    return;
  }

  const existingCategories = getAllCategories(connection.identity?.userId);
  const maxSortOrder = existingCategories.reduce((max, cat) => Math.max(max, cat.sortOrder), -1);

  const category = {
    id: randomUUID(),
    name,
    sortOrder: maxSortOrder + 1,
    collapsed: false,
    ownerId: connection.identity?.userId || null,
    createdAt: new Date().toISOString(),
  };

  insertCategory(category);

  connection.ws.send(createMessage('category.created', { category: categoryToInfo(category) }, message.id));
  broadcastCategoryUpdate('created', { category: categoryToInfo(category) }, connection.id);
}

export function handleCategoryRename(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryRenamePayload;

  if (!payload?.categoryId || !payload?.name || typeof payload.name !== 'string') {
    connection.ws.send(createMessage('error', { message: 'Category ID and name required' }, message.id));
    return;
  }

  const name = payload.name.trim().slice(0, 100);
  if (!name) {
    connection.ws.send(createMessage('error', { message: 'Category name cannot be empty' }, message.id));
    return;
  }

  const existing = getCategory(payload.categoryId);
  if (!existing) {
    connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
    return;
  }

  updateCategory(payload.categoryId, { name });

  connection.ws.send(createMessage('category.renamed', { categoryId: payload.categoryId, name }, message.id));
  broadcastCategoryUpdate('renamed', { categoryId: payload.categoryId, name }, connection.id);
}

export function handleCategoryDelete(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryDeletePayload;

  if (!payload?.categoryId) {
    connection.ws.send(createMessage('error', { message: 'Category ID required' }, message.id));
    return;
  }

  const existing = getCategory(payload.categoryId);
  if (!existing) {
    connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
    return;
  }

  deleteCategoryFromDb(payload.categoryId);

  connection.ws.send(createMessage('category.deleted', { categoryId: payload.categoryId }, message.id));
  broadcastCategoryUpdate('deleted', { categoryId: payload.categoryId }, connection.id);
}

export function handleCategoryReorder(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryReorderPayload;

  if (!payload?.categories || !Array.isArray(payload.categories)) {
    connection.ws.send(createMessage('error', { message: 'Categories array required' }, message.id));
    return;
  }

  reorderCategories(payload.categories);

  connection.ws.send(createMessage('category.reordered', { categories: payload.categories }, message.id));
  broadcastCategoryUpdate('reordered', { categories: payload.categories }, connection.id);
}

export function handleCategoryToggle(connection: ClientConnection, message: ClientMessage): void {
  const payload = message.payload as CategoryTogglePayload;

  if (!payload?.categoryId || typeof payload.collapsed !== 'boolean') {
    connection.ws.send(createMessage('error', { message: 'Category ID and collapsed state required' }, message.id));
    return;
  }

  const existing = getCategory(payload.categoryId);
  if (!existing) {
    connection.ws.send(createMessage('error', { message: 'Category not found' }, message.id));
    return;
  }

  updateCategory(payload.categoryId, { collapsed: payload.collapsed });

  connection.ws.send(createMessage('category.toggled', { categoryId: payload.categoryId, collapsed: payload.collapsed }, message.id));
  broadcastCategoryUpdate('toggled', { categoryId: payload.categoryId, collapsed: payload.collapsed }, connection.id);
}
