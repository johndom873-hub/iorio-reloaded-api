// Postgres `date` columns come back from pg as a JS Date at LOCAL midnight (no type parser is
// registered for OID 1082), so toISOString() would shift the day for any zone east of UTC.
// Read the local calendar parts instead; a string (raw query, ::text) passes through.
export function isoDateFromDbDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
}
