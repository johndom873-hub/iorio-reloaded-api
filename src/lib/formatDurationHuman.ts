// Formats a millisecond duration as a short human string for notifications
// (e.g. "3h 19m", "45m", "12s"). Rounds down to whole units and drops the
// smaller unit once the larger one is 0, matching how someone would say a
// duration out loud rather than showing every unit down to milliseconds.
export function formatDurationHuman(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
