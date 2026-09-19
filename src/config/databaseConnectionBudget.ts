// Heroku Postgres Essential-1 lets the app's role hold at most 20 connections
// (pg_roles.rolconnlimit), shared by EVERY process that connects. Node's
// defaults (knex/tarn max 10, pg.Pool max 10) let the web dyno alone reach 21
// once the session store and the LISTEN client are counted, so a burst of
// concurrent authenticated requests could exhaust the role ("too many
// connections", code 53300 — seen 2026-09-19, see PROGRESS.md). Explicit
// ceilings, budgeted for the worst case at the same moment:
//
//   web dyno         knex 4 + session store 3 + notification LISTEN 1  =  8
//   VPS worker       knex 4 + its LISTEN clients (~2)                    =  6
//   one scheduler job  knex 4                                            =  4
//                                                                   total 18
//
// leaving ~2 for psql / pg:pull. Waiting requests queue on the pool rather
// than failing. Raise these only together with re-checking that sum.
export const databaseConnectionBudget = {
  knexPoolMax: 4,
  sessionStorePoolMax: 3,
} as const;
