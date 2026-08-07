import { EventEmitter } from 'node:events';
import type { Event, EventKind } from '@wick/shared';

type EventOfKind<K extends EventKind> = Extract<Event, { kind: K }>;

class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // The bus may accumulate many subscribers (one per SSE client etc).
    this.emitter.setMaxListeners(0);
  }

  /** Emit a typed event to both the `event` firehose and the per-kind channel. */
  emit(event: Event): void {
    this.emitter.emit('event', event);
    this.emitter.emit(event.kind, event);
  }

  /** Subscribe to a single event kind. Returns an unsubscribe function. */
  on<K extends EventKind>(
    kind: K,
    handler: (event: EventOfKind<K>) => void,
  ): () => void {
    const listener = (event: Event): void => {
      handler(event as EventOfKind<K>);
    };
    this.emitter.on(kind, listener);
    return () => {
      this.emitter.off(kind, listener);
    };
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  onAny(handler: (event: Event) => void): () => void {
    const listener = (event: Event): void => {
      handler(event);
    };
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}

export const eventBus = new EventBus();
export type { EventBus };
