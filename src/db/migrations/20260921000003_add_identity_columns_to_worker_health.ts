import type { Knex } from "knex";

// Observation only (Phase B work package 1): the worker records WHAT it is
// (code version, environment, which IBKR account(s) and whether they look
// like paper or live) next to its connection stats, so drift between the
// worker and the API, or a paper/live mix-up, is visible before anything
// enforces it. All nullable — rows written by an older worker simply leave
// them empty, so old and new worker code can coexist during a deploy.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.text("git_sha");
    table.text("app_environment");
    table.specificType("ibkr_account_ids", "text[]");
    table.text("detected_trading_mode");
    table.text("configured_trading_mode");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.dropColumn("git_sha");
    table.dropColumn("app_environment");
    table.dropColumn("ibkr_account_ids");
    table.dropColumn("detected_trading_mode");
    table.dropColumn("configured_trading_mode");
  });
}
