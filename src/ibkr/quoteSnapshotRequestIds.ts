// Request ids for the worker's one-shot quote snapshots (the limit-price check right before placement). The worker's error handler
// matches an IBKR error's id against the order ids of submitted orders, so a snapshot id must never fall in the order-id range or
// share an id with another request: a market-data error would otherwise be read as "that order failed". One counter for the whole
// process, in a range clear of the order ids IBKR hands out (contractResolutionRequestIds.ts holds 70_000-79_999).
const firstQuoteSnapshotRequestId = 80_000;
const quoteSnapshotRequestIdCount = 10_000;

let nextOffset = 0;

export function allocateQuoteSnapshotRequestId(): number {
  const requestId = firstQuoteSnapshotRequestId + nextOffset;
  nextOffset = (nextOffset + 1) % quoteSnapshotRequestIdCount;
  return requestId;
}
