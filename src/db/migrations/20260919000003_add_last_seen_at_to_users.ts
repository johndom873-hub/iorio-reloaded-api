import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("users", (table) => {
    // When this user last had a tab of the app open — stamped on every
    // /notifications/stream connect and disconnect (see userLastSeen.ts), for
    // Iorio Pulse's Front End card. Null until their first connection after
    // this column shipped.
    table.timestamp("last_seen_at", { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("users", (table) => {
    table.dropColumn("last_seen_at");
  });
}
