import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guard (2026-10-07): an Intl formatter built inside a function keeps ~25 KB of native ICU memory per call until V8
// happens to collect its small JS wrapper, which it rarely does when the heap is quiet. Pluto's agent reached 800 MB
// on a 512 MB dyno that way (easternDateIso, called ~150 times a second). Formatters are built once, at module level;
// a toLocale*String or localeCompare given options builds one per call too. Number toLocaleString("en-US") (a string
// locale and no options) is cached by V8 and allowed.

const allowedInsideFunctions = new Map<string, string>([
  ["src/ibkr/ibkrGatewayParseExecutionTime.ts", "one formatter per IANA zone, built once and kept in a Map"],
]);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [full] : [];
  });
}

describe("Intl formatters are built once", () => {
  const files = [...sourceFiles("src"), ...sourceFiles("scripts")];

  it("never builds an Intl formatter inside a function (with or without `new`)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (allowedInsideFunctions.has(file)) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const buildsFormatter = /(^|[^.\w])Intl\.(DateTimeFormat|NumberFormat|Collator|PluralRules|RelativeTimeFormat|ListFormat|DisplayNames|Segmenter)\s*\(/.test(line);
        if (buildsFormatter && !/^(export )?const \w+ = new Intl\./.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("never gives toLocale*String or localeCompare an options argument, inline, by variable or on the next line", () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const call = line.match(/\.(toLocale(Date|Time)?String|localeCompare)\(([^)]*)(\)|$)/);
        if (!call) return;
        const commaCount = (call[3]!.match(/,/g) ?? []).length;
        const continuesOnNextLine = call[4] === "";
        const optionsArgumentIndex = call[1] === "localeCompare" ? 2 : 1;
        if (commaCount >= optionsArgumentIndex || (continuesOnNextLine && commaCount >= optionsArgumentIndex - 1)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
