import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("user_passkeys", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("user_id").notNullable().references("id").inTable("users").onDelete("CASCADE");
    // base64url credential id exactly as the browser reports it; sign-in finds the user from this alone.
    table.text("credential_id").notNullable().unique();
    table.binary("public_key").notNullable();
    // WebAuthn signature counter. Synced passkeys (iCloud Keychain, LastPass) report 0 forever; that is normal.
    table.bigInteger("counter").notNullable().defaultTo(0);
    table.specificType("transports", "text[]");
    table.text("device_type").notNullable();
    table.boolean("backed_up").notNullable();
    table.text("registered_user_agent");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Null until the passkey has signed in once. A user with no passkey that has ever been used may still
    // enrol with their password, so a passkey that was saved but never worked cannot lock them out.
    table.timestamp("last_used_at", { useTz: true });
  });
  await knex.schema.raw("create index user_passkeys_user_id_index on user_passkeys (user_id)");

  await knex.schema.alterTable("users", (table) => {
    // Accounts used by the system itself (Genosuke). With passkeys required they may still sign in with a
    // password, but only from inside the web dyno (no X-Forwarded-For), never from the internet.
    table.boolean("is_service_account").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("users", (table) => {
    table.dropColumn("is_service_account");
  });
  await knex.schema.dropTableIfExists("user_passkeys");
}
