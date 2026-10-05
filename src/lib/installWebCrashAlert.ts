import { installCrashHandlers } from "./installCrashHandlers.js";

// Imported as the FIRST import of server.ts, for its side effect. installCrashHandlers("web") used to run
// after the static imports, so an error thrown while they loaded (config/env.ts on a missing variable)
// crashed the dyno before any handler existed and sent no Telegram alert.
installCrashHandlers("web");
