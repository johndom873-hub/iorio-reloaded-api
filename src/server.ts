import { app } from "./app.js";
import { environment } from "./config/env.js";
import { startGenosuke } from "./genosuke/bot.js";

app.listen(environment.port, () => {
  console.log(`Iorio Reloaded API listening on port ${environment.port} (${environment.nodeEnvironment})`);
  // No-ops until GENOSUKE_POLLING_ENABLED + the rest of its config is set —
  // see genosuke/config.ts. Fire-and-forget, started after listen() so the
  // self-authenticating API client (genosuke/apiClient.ts) has a live
  // server to call.
  startGenosuke();
});
