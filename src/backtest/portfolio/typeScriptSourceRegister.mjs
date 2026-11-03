// Registers typeScriptSourceResolve.mjs: passed to a worker thread as --import (portfolioProjectionPool.ts).
import { register } from "node:module";

register("./typeScriptSourceResolve.mjs", import.meta.url);
