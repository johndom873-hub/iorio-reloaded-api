import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Knex } from "knex";
import { postgresSslOption } from "../config/databaseSsl.js";

// Knex changes its working directory to this file's folder before running,
// so dotenv's default CWD-relative lookup won't find the project root .env.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadDotenv({ path: path.join(projectRoot, ".env"), quiet: true });

const sharedConfig: Partial<Knex.Config> = {
  client: "pg",
  migrations: {
    directory: "./migrations",
    // Locally this file runs as TS via tsx, resolving .ts migration files
    // directly. On Heroku it runs compiled, as dist/src/db/knexfile.js
    // (tsx is a devDependency and gets pruned from the production slug), so
    // it needs to resolve the compiled .js migrations sitting next to it.
    // Taken from this file's own extension, not from any environment variable.
    extension: path.extname(fileURLToPath(import.meta.url)).slice(1),
  },
};

// Knex picks the entry named by NODE_ENV (or --env); the entries differ only in which database they point at and in the pool.
// SSL comes from DATABASE_SSL (config/databaseSsl.ts), read when knex opens the connection, so `--env test` does not need it.
const databaseConnection = () => ({ connectionString: process.env.DATABASE_URL, ssl: postgresSslOption() });

const config: Record<string, Knex.Config> = {
  development: {
    ...sharedConfig,
    connection: databaseConnection,
  },
  test: {
    ...sharedConfig,
    connection: process.env.TEST_DATABASE_URL,
  },
  production: {
    ...sharedConfig,
    connection: databaseConnection,
    pool: { min: 2, max: 10 },
  },
};

export default config;
