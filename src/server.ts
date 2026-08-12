import { app } from "./app.js";
import { environment } from "./config/env.js";

app.listen(environment.port, () => {
  console.log(`Iorio Reloaded API listening on port ${environment.port} (${environment.nodeEnvironment})`);
});
