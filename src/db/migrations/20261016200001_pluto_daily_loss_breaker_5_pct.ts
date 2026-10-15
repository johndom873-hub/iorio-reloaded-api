import type { Knex } from "knex";

// Pluto's daily-loss breaker at 5% of the account (Marcelo 2026-10-15), one value for both strategies: the column default,
// so a new database starts there, and the saved value everywhere, so every environment matches. A changed value is logged
// in the settings audit like a change from the screen, with no user.
export async function up(knex: Knex): Promise<void> {
  await knex.raw("alter table pluto_settings alter column daily_loss_breaker_pct set default 5");
  await knex.raw(`
    insert into pluto_settings_audit (user_id, field, old_value, new_value)
    select null, 'dailyLossBreakerPct', trim_scale(daily_loss_breaker_pct)::text, '5'
    from pluto_settings
    where daily_loss_breaker_pct <> 5
  `);
  await knex.raw("update pluto_settings set daily_loss_breaker_pct = 5, updated_at = now() where daily_loss_breaker_pct <> 5");
}

// The default goes back; a saved value stays as it is, since it may have been set on the screen since.
export async function down(knex: Knex): Promise<void> {
  await knex.raw("alter table pluto_settings alter column daily_loss_breaker_pct set default 2");
}
