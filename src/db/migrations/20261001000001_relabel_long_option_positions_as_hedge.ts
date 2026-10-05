import type { Knex } from "knex";

// A long option bought outside the app is its own strategy, "hedge" (approved 2026-10-01), instead of
// the catch-all "unstructured". Position labels are fixed at creation, so positions the reconciler
// created before this strategy existed are relabelled once here: only those whose every leg is a
// long option (a position that also holds shares or a short leg is a different, genuinely
// unstructured case and stays as it is).
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE positions p
    SET strategy_key = 'hedge', unstructured_reason = NULL
    WHERE p.strategy_key = 'unstructured'
      AND EXISTS (SELECT 1 FROM position_legs pl WHERE pl.position_id = p.id)
      AND NOT EXISTS (
        SELECT 1 FROM position_legs pl
        WHERE pl.position_id = p.id AND NOT (pl.leg_type = 'option' AND pl.side = 'long')
      )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE positions
    SET strategy_key = 'unstructured', unstructured_reason = 'unknown'
    WHERE strategy_key = 'hedge'
  `);
}
