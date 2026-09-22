import type { Knex } from "knex";

// Nightly SVI surface fits (IORIO Signal Engine, Formula 3b, approved 2026-09-22):
// one row per (option_chain_snapshots row, expiry) with the fitted raw-SVI
// parameters and the quality/arbitrage flags. Derived data: it can always be
// recomputed from option_quote_snapshots (npm run job:option-surface-fit), so
// it is deliberately kept apart from the irreplaceable raw archive and is
// replaced wholesale on a re-fit. ON DELETE CASCADE follows the snapshot.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("option_surface_fits", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("snapshot_id").notNullable().references("id").inTable("option_chain_snapshots").onDelete("CASCADE");
    table.date("expiry").notNullable();
    table.decimal("years_to_expiry", 10, 6).notNullable();
    table.decimal("forward_price", 14, 4).notNullable();
    table.text("status").notNullable();
    table.integer("point_count").notNullable();
    table.jsonb("dropped_counts").notNullable();
    table.decimal("rmse_volatility", 8, 6);
    table.decimal("min_butterfly_density", 12, 4);
    table.decimal("k_min", 9, 5);
    table.decimal("k_max", 9, 5);
    // Raw SVI: w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2)); null unless a fit was produced.
    table.decimal("param_a", 14, 8);
    table.decimal("param_b", 14, 8);
    table.decimal("param_rho", 10, 8);
    table.decimal("param_m", 12, 8);
    table.decimal("param_sigma", 12, 8);
    // Calendar-arbitrage check of this slice against the previous fitted expiry.
    table.integer("calendar_checks").notNullable().defaultTo(0);
    table.integer("calendar_violations").notNullable().defaultTo(0);
    table.timestamp("fitted_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["snapshot_id", "expiry"]);
  });
  await knex.raw(
    `ALTER TABLE option_surface_fits ADD CONSTRAINT option_surface_fits_status_check CHECK (status IN ('ok','insufficient_points','fit_failed','poor_fit','butterfly_arbitrage'))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("option_surface_fits");
}
