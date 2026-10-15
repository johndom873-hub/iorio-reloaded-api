/** An ILIKE pattern that matches `text` anywhere in the value, with %, _ and the backslash taken literally. */
export function sqlContainsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
