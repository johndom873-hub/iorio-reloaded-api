// Reads a dollar figure back out of a gate's text, as formatWholeDollars writes it: "budget left $450,000",
// "ticker room −$1,084".
export function dollarsAfter(label: string, text: string): number {
  const match = new RegExp(`${label} (−?)\\$([\\d,]+)`).exec(text);
  if (!match) throw new Error(`No "${label} $…" in: ${text}`);
  return (match[1] ? -1 : 1) * Number(match[2]!.replaceAll(",", ""));
}
