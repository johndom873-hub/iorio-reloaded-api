import { config } from "dotenv";
import knexLibrary, { type Knex } from "knex";

// A private copy of the test database's tables for one test file, so a test can rely on the exact contents of global tables
// (account_pnl_snapshots, market_calendar, ...) while other test files run against the shared schema. Every table of the public
// schema is recreated empty (columns, defaults, constraints, indexes; no foreign keys, no rows), and the returned connection resolves
// unqualified names to the private copy first. Call dropIsolatedTestDatabase when the file is done.

const tablesNotCopied = ["knex_migrations", "knex_migrations_lock"];

export async function createIsolatedTestDatabase(): Promise<Knex> {
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run database tests.");
  const schemaName = `isolated_test_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

  const setupConnection = knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 1 } });
  try {
    await setupConnection.raw(`CREATE SCHEMA "${schemaName}"`);
    const tables = await setupConnection.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    for (const { table_name: tableName } of tables.rows as { table_name: string }[]) {
      if (tablesNotCopied.includes(tableName)) continue;
      await setupConnection.raw(`CREATE TABLE "${schemaName}"."${tableName}" (LIKE public."${tableName}" INCLUDING ALL)`);
    }
  } finally {
    await setupConnection.destroy();
  }

  return knexLibrary({
    client: "pg",
    connection: process.env.TEST_DATABASE_URL,
    pool: {
      min: 0,
      max: 4,
      afterCreate: (connection: { query: (sql: string, callback: (error: Error | null) => void) => void }, done: (error: Error | null, connection: unknown) => void) => {
        connection.query(`SET search_path TO "${schemaName}", public`, (error) => done(error, connection));
      },
    },
  });
}

/** Drops the private schema created by createIsolatedTestDatabase and closes the connection. */
export async function dropIsolatedTestDatabase(isolatedDb: Knex): Promise<void> {
  const result = await isolatedDb.raw("SELECT current_schema() AS schema_name");
  const schemaName = result.rows[0].schema_name as string;
  if (!schemaName.startsWith("isolated_test_")) throw new Error(`Refusing to drop schema ${schemaName}: not an isolated test schema.`);
  await isolatedDb.raw(`DROP SCHEMA "${schemaName}" CASCADE`);
  await isolatedDb.destroy();
}
