import type { Knex } from "knex";

// Access levels (Marcelo 2026-10-17): an admin can do everything; a trader cannot change risk limits or Pluto, cannot lift a
// halt or start Pluto, and trades only the capital outside Pluto's budget. Everyone but Marcelo is a trader; Pluto's own
// service account is an admin, since its orders are on the tickers traders may not trade. New users default to trader.
//   users.access_level        admin | trader
//   users.disabled_at         set: the user cannot sign in, and a live session is refused on its next request
//   risk_limits_audit         who changed which Risk & Limits field (and the trading halt) from what to what, when
//   order_requests.confirmed_by_user_id   who pressed Confirm

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("users", (table) => {
    table.text("access_level").notNullable().defaultTo("trader");
    table.timestamp("disabled_at", { useTz: true });
  });
  await knex.raw("ALTER TABLE users ADD CONSTRAINT users_access_level_valid CHECK (access_level IN ('admin', 'trader'))");
  await knex("users").whereRaw("lower(username) IN ('marce', 'pluto')").update({ access_level: "admin" });

  await knex.schema.createTable("risk_limits_audit", (table) => {
    table.bigIncrements("id");
    table.timestamp("changed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid("user_id").references("id").inTable("users").onDelete("SET NULL");
    table.text("field").notNullable();
    table.text("old_value");
    table.text("new_value");
    // The trading halt's reason, on a tradingHalt row.
    table.text("reason");
    table.index(["changed_at"]);
  });

  await knex.schema.alterTable("order_requests", (table) => {
    table.uuid("confirmed_by_user_id").references("id").inTable("users").onDelete("SET NULL");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("confirmed_by_user_id");
  });
  await knex.schema.dropTableIfExists("risk_limits_audit");
  await knex.raw("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_access_level_valid");
  await knex.schema.alterTable("users", (table) => {
    table.dropColumn("disabled_at");
    table.dropColumn("access_level");
  });
}
