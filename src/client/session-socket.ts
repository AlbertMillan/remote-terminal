import type { ErrorPayload, ServerMessage } from './session-types.js';

/**
 * The page's one WebSocket to `/ws`: connect, reconnect with backoff, numbered sends, and
 * requests that resolve on the answer carrying their id. What the messages mean is the
 * session manager's; this only moves them.
 */

const REQUEST_TIMEOUT_MS = 30000;
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

export interface SessionSocketHandlers {
  onStatus(status: 'connecting' | 'connected' | 'disconnected'): void;
  onOpen(): void;
  onClose(): void;
  onMessage(message: ServerMessage): void;
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private reconnectAttempts = 0;

  constructor(private readonly handlers: SessionSocketHandlers) {}

  connect(): void {
    // Close existing WebSocket to prevent duplicate connections
    if (this.ws) {
      // Remove handlers before closing to prevent reconnect loop
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.handlers.onStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      this.handlers.onStatus('connected');
      this.handlers.onOpen();
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.handlers.onStatus('disconnected');
      this.handlers.onClose();
      this.attemptReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        console.error('Invalid message:', event.data);
        return;
      }
      // An error answering a request is that request's rejection, not a message to show.
      if (this.settle(message)) return;
      this.handlers.onMessage(message);
    };
  }

  /** Closes the socket; the close handler still runs (and reconnects). */
  close(): void {
    this.ws?.close();
  }

  /** Sends a message and returns its id; dropped silently while the socket is down. */
  send(type: string, payload?: unknown): string {
    const id = String(++this.messageId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, id, payload }));
    }
    return id;
  }

  /** Sends and resolves with the answer's payload; rejects on an error answer or after 30 s. */
  request<T = any>(type: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.send(type, payload);
      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  /**
   * Answers a pending request (issue #4: rejected on an error answer). True when the message
   * was an error consumed as a rejection; a success still goes on to its handler.
   */
  private settle(message: ServerMessage): boolean {
    if (!message.id || !this.pendingRequests.has(message.id)) return false;
    const { resolve, reject } = this.pendingRequests.get(message.id)!;
    this.pendingRequests.delete(message.id);
    if (message.type === 'error' || message.type === 'session.error') {
      const errorPayload = message.payload as ErrorPayload;
      // A refused launch keeps its refusal, for the Log in / Clean up dialog.
      reject(Object.assign(new Error(errorPayload?.message || 'Request failed'), { refusal: errorPayload?.refusal }));
      return true;
    }
    resolve(message.payload);
    return false;
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log('Max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), delay);
  }
}
