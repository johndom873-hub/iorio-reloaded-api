import type { Knex } from "knex";

// Set by hand on an expired short option leg that a person has reviewed and settled outside the nightly
// expiry-settlement audit, so the audit stops examining it and stops alerting every night. Nothing sets it automatically.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.timestamp("settlement_audit_acknowledged_at", { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.dropColumn("settlement_audit_acknowledged_at");
  });
}
