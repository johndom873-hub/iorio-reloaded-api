// A resolve hook for worker threads that run the TypeScript source with Node's own type handling instead of tsx (whose
// esbuild keepNames wraps every function made at run time in a naming call: about 10% of a projection, 2026-11-03).
// The source imports its siblings as "./x.js"; where no such file exists and "./x.ts" does, that is what is loaded.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const asJs = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(asJs))) {
      const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(asTs))) return nextResolve(asTs.href, context);
    }
  }
  return nextResolve(specifier, context);
}
