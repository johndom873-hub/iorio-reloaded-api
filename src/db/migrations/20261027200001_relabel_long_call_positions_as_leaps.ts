import type { Knex } from "knex";

// Hedge means protective Puts, and every long Call is a LEAPS (Marcelo 2026-10-27): a position of its own strategy,
// "leaps". Position labels are fixed at creation, so the long Call positions the reconciler filed as "hedge" (staging's
// TLT Call) are relabelled once here: only those whose every leg is a long Call.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE positions p
    SET strategy_key = 'leaps'
    WHERE p.strategy_key = 'hedge'
      AND EXISTS (SELECT 1 FROM position_legs pl WHERE pl.position_id = p.id)
      AND NOT EXISTS (
        SELECT 1 FROM position_legs pl
        WHERE pl.position_id = p.id AND NOT (pl.leg_type = 'option' AND pl.side = 'long' AND pl.option_type = 'call')
      )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE positions
    SET strategy_key = 'hedge'
    WHERE strategy_key = 'leaps'
  `);
}
