/** "20261106" → "2026-11-06". */
export function formatExpiryAsIsoDate(expiryYyyymmdd: string): string {
  if (!/^\d{8}$/.test(expiryYyyymmdd)) throw new Error(`Expected a YYYYMMDD expiry, got "${expiryYyyymmdd}"`);
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}

/** "2026-11-06" → "20261106". */
export function formatIsoDateAsExpiry(dateIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw new Error(`Expected a YYYY-MM-DD date, got "${dateIso}"`);
  return dateIso.replaceAll("-", "");
}
