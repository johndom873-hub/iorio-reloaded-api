// Starting the engine's worker threads (the day-data reader, the Analyse window's chain scan) the same way under tsx and
// compiled.

/** A worker module of the engine (next to this one) by its base name: the TypeScript source under tsx, the compiled file otherwise. */
export function engineWorkerModuleUrl(baseName: string): URL {
  return new URL(import.meta.url.endsWith(".ts") ? `./${baseName}.ts` : `./${baseName}.js`, import.meta.url);
}

/** A worker runs the TypeScript source through tsx as this process does; a process not started through tsx (a test runner) registers it. */
export function engineWorkerExecArgv(): string[] | undefined {
  if (!import.meta.url.endsWith(".ts")) return undefined;
  return process.execArgv.some((argument) => argument.includes("tsx")) ? undefined : ["--import", "tsx"];
}
