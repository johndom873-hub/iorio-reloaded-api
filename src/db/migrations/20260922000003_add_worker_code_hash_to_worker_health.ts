import type { Knex } from "knex";

// Phase B: the hash of the worker's actual transitive source closure (see
// computeSourceClosureHash.ts) it started up running — NOT the same thing as git_sha (which
// commit), this is "would redeploying this commit's worker code actually change anything the
// worker runs." The release-phase deploy compares against this to decide whether to skip the
// worker step entirely for an API-only change. Nullable: an older worker's row just means "unknown,
// deploy to be safe" until it reports in with the new code.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.text("worker_code_hash");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("worker_health", (table) => {
    table.dropColumn("worker_code_hash");
  });
}
