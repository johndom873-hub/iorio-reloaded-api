import path from "node:path";
import { installCrashHandlers } from "./installCrashHandlers.js";

// Imported as the FIRST import of every scheduled script, for its side effect. ESM evaluates
// imports in order, so this registers the crash alert before config/env.ts (which throws on a
// missing variable) or the database module load. Without it a script that dies at import time
// exits with no job_runs row and no Telegram message. It depends only on notifyTelegram, which
// reads process.env lazily and needs no database.
installCrashHandlers(path.basename(process.argv[1] ?? "script").replace(/\.[cm]?[jt]s$/, ""));
