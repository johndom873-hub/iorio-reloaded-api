import { EventEmitter } from "node:events";

// In-process fan-out from the Day Signals loop to the Signals stream
// producers (both live in the web dyno): "this ticker's day quotes changed,
// reload and re-score". No Postgres round trip — the loop and the producers
// share the process by design (see PROGRESS.md "DAY SIGNALS").
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
const eventName = "dayQuotesUpdated";

export function emitDayQuotesUpdated(tickerId: string): void {
  emitter.emit(eventName, tickerId);
}

export function onDayQuotesUpdated(listener: (tickerId: string) => void): () => void {
  emitter.on(eventName, listener);
  return () => emitter.off(eventName, listener);
}
