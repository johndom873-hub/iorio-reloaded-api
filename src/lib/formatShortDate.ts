// "2026-10-16" → "Oct 16", for notification text. Parsed from the string
// directly rather than via `new Date(...)`, so a fixed calendar date can't
// shift a day with the machine's timezone.
const monthAbbreviations = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatShortDate(isoDate: string): string {
  const parts = isoDate.split("-");
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return `${monthAbbreviations[month - 1]} ${day}`;
}
