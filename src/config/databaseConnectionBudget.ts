// Heroku Postgres Essential-1 lets the app's role hold at most 20 connections
// (pg_roles.rolconnlimit), shared by EVERY process that connects. Node's
// defaults (knex/tarn max 10, pg.Pool max 10) let the web dyno alone reach 21
// once the session store and the LISTEN client are counted, so a burst of
// concurrent authenticated requests could exhaust the role ("too many
// connections", code 53300 — seen 2026-09-19, see PROGRESS.md). Explicit
// ceilings, budgeted for the worst case at the same moment:
//
//   web dyno         knex 4 + session store 2 + notification LISTEN 1  =  7
//   VPS worker       knex 4 + its LISTEN clients (~2)                    =  6
//   two scheduler jobs at once  knex 2 each                              =  4
//   Pluto agent      knex 2 + notification LISTEN 1                      =  3
//                                                                   total 20
//
// That worst case leaves nothing for psql / pg:pull (Marcelo, 2026-10-07: accepted; everything peaks together only
// around the 10:00 ET capture, and 13 connections were in use on an ordinary morning). The agent runs one round at a
// time, so 2 connections only queue a round's parallel reads; the session store issues one small query per request.
// A larger plan is the fix once Pluto also runs on prod. Two jobs overlap routinely: every daily
// Scheduler entry sits on a :00/:30 slot that the 10-minute IBKR health
// check also fires on, and the 10:00 ET chain capture runs ~20 minutes.
// A job script's queries are sequential, so 2 connections lose nothing
// (db/connection.ts picks jobKnexPoolMax for anything started from
// scripts/). Waiting requests queue on the pool rather than failing. Raise
// these only together with re-checking that sum.
export const databaseConnectionBudget = {
  knexPoolMax: 4,
  jobKnexPoolMax: 2,
  agentKnexPoolMax: 2,
  sessionStorePoolMax: 2,
} as const;
