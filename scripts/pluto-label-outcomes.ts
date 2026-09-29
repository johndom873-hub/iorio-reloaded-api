import "dotenv/config";
// Labels the hold-to-expiry outcome of every candidate Pluto has offered whose expiry has settled.
// The agent does this once a day by itself; run by hand after a bar back-fill or before a backtest.
//   npm run pluto:label-outcomes
import { db } from "../src/db/connection.js";
import { labelExpiredCandidateOutcomes } from "../src/pluto/candidateOutcomes.js";

const result = await labelExpiredCandidateOutcomes();
console.log(`labelled ${result.labelled}, pending expiry ${result.pending}${result.missingBars.length > 0 ? `, no bar within 5 days for: ${result.missingBars.join(", ")}` : ""}`);
await db.destroy();
process.exit(0);
