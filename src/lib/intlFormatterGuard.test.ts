import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Guard (2026-10-07): an Intl formatter built inside a function keeps ~25 KB of native ICU memory per call until V8
// happens to collect its small JS wrapper, which it rarely does when the heap is quiet. Pluto's agent reached 800 MB
// on a 512 MB dyno that way (easternDateIso, called ~150 times a second). Formatters are built once, at module level;
// a Date's toLocale*String with an options object builds one per call too. Number toLocaleString("en-US") is cached
// by V8 and allowed.

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

  it("never builds an Intl formatter inside a function", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (allowedInsideFunctions.has(file)) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (line.includes("new Intl.") && !/^(export )?const \w+ = new Intl\./.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("never formats a Date with toLocale*String and an options object", () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/\.toLocale(Date|Time)?String\([^)]*,\s*\{/.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
