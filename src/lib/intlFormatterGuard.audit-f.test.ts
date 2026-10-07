import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Audit F (2026-10-07): intlFormatterGuard.test.ts matches `new Intl.` and `.toLocale*String(..., {` on one line. These cover the
// per-call formatter shapes it lets through, plus a self-check that its two regexes catch what they claim.

const guardInsideFunctions = (line: string) => line.includes("new Intl.") && !/^(export )?const \w+ = new Intl\./.test(line);
const guardDateOptions = (line: string) => /\.toLocale(Date|Time)?String\([^)]*,\s*\{/.test(line);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js|mjs|cjs)$/.test(entry.name) && !entry.name.includes(".test.") ? [full] : [];
  });
}

describe("the guard's own patterns", () => {
  it("flag a formatter built inside a function and pass a module-level one", () => {
    expect(guardInsideFunctions('  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone });')).toBe(true);
    expect(guardInsideFunctions('export const f = (at: Date) => new Intl.DateTimeFormat("en-US").format(at);')).toBe(true);
    expect(guardInsideFunctions('const easternDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });')).toBe(false);
    expect(guardInsideFunctions('export const numberFormatter = new Intl.NumberFormat("en-US");')).toBe(false);
  });
  it("flag Date/Number toLocale*String with an inline options object", () => {
    expect(guardDateOptions('at.toLocaleDateString("en-CA", { timeZone: "America/New_York" })')).toBe(true);
    expect(guardDateOptions('at.toLocaleTimeString("en-US", { hour: "2-digit" })')).toBe(true);
    expect(guardDateOptions('value.toLocaleString("en-US", { maximumFractionDigits: 2 })')).toBe(true);
    expect(guardDateOptions('Math.round(amount).toLocaleString("en-US")')).toBe(false);
  });
  it("do NOT see these per-call shapes (why the scan below exists)", () => {
    expect(guardInsideFunctions('  return Intl.DateTimeFormat("en-US", { timeZone: zone }).format(at);')).toBe(false);
    expect(guardDateOptions('  return at.toLocaleDateString("en-CA", options);')).toBe(false);
    expect(guardDateOptions("  return at.toLocaleDateString(\"en-CA\", ")).toBe(false);
  });
});

describe("source has no per-call formatter the guard would miss", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("scripts")];

  it("no Intl constructor called without `new` (it builds a formatter just the same)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/(^|[^.\w])Intl\.(DateTimeFormat|NumberFormat|Collator|PluralRules|RelativeTimeFormat|ListFormat|DisplayNames|Segmenter)\s*\(/.test(line) && !line.includes("new Intl.")) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no toLocale*String / localeCompare given an options argument, inline, by variable, or on the next line", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        const call = line.match(/\.(toLocale(Date|Time)?String|localeCompare)\(([^)]*)(\)|$)/);
        if (!call) return;
        const argumentsText = call[3]!;
        const commaCount = (argumentsText.match(/,/g) ?? []).length;
        const continues = call[4] === "";
        const optionsArgumentIndex = call[1] === "localeCompare" ? 2 : 1;
        if (commaCount >= optionsArgumentIndex || (continues && commaCount >= optionsArgumentIndex - 1)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
