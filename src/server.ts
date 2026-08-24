import { app } from "./app.js";
import { environment, requireEnvironmentVariable } from "./config/env.js";
import { startGenosuke } from "./genosuke/bot.js";

// Only the web dyno gets a $PORT from Heroku — read lazily here rather than
// eagerly in the shared `environment` object, so the worker dyno (which
// imports environment.ts for IBKR config but never binds a port) doesn't
// crash on a missing PORT.
const port = Number(requireEnvironmentVariable("PORT"));

app.listen(port, () => {
  console.log(`Iorio Reloaded API listening on port ${port} (${environment.nodeEnvironment})`);
  // No-ops until GENOSUKE_ENABLED + the rest of its config is set —
  // see genosuke/config.ts. Fire-and-forget, started after listen() so the
  // self-authenticating API client (genosuke/apiClient.ts) has a live
  // server to call.
  startGenosuke();
});
