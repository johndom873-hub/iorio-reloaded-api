import knexLibrary from "knex";
import { environment } from "../config/env.js";

export const db = knexLibrary({
  client: "pg",
  connection: environment.databaseUrl,
});
