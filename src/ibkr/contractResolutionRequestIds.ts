// Request ids for the worker's reqContractDetails calls. Every call used to start at 70_000, so two orders
// resolving at the same time shared an id and each could take the other's contract. One counter for the whole
// process keeps them unique; the range sits clear of the order ids IBKR hands out and of the other request ids.
const firstContractResolutionRequestId = 70_000;
const contractResolutionRequestIdCount = 10_000;

let nextOffset = 0;

export function allocateContractResolutionRequestId(): number {
  const requestId = firstContractResolutionRequestId + nextOffset;
  nextOffset = (nextOffset + 1) % contractResolutionRequestIdCount;
  return requestId;
}
