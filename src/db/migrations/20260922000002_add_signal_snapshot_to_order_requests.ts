import type { Knex } from "knex";

// The Signals modal's order setup (stage 5, approved 2026-09-22) saves the scores
// the contract had at the moment the order was built -- surface IV, forecast, net
// Edge at bid and mid, Edge $, delta, flags, grade, the ticker's tilt measures and
// when it was selected -- so Phase 2 can test what actually predicted the outcome.
// Kept OUT of `payload`, which is the IBKR-build contract the worker parses.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.jsonb("signal_snapshot");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("signal_snapshot");
  });
}
