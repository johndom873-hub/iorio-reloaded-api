import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const tradeAlertsRouter = Router();
tradeAlertsRouter.use(requireAuth);

// v1 strategy scope — matches positions.ts/screener.ts.
const validStrategyKeys = ["covered_call", "cash_secured_put"];
const validStatuses = ["pending", "approved", "rejected", "modified", "expired"];

tradeAlertsRouter.get("/", async (request, response) => {
  const status = (request.query.status as string | undefined) ?? "pending";
  const strategyKey = request.query.strategy as string | undefined;

  if (!validStatuses.includes(status)) {
    response.status(400).json({ error: "Unknown status." });
    return;
  }
  if (strategyKey && !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "Unknown strategy." });
    return;
  }

  const conditions = ["ta.status = ?"];
  const params: string[] = [status];
  if (strategyKey) {
    conditions.push("ta.strategy_key = ?");
    params.push(strategyKey);
  }

  const result = await db.raw(
    `
    SELECT
      ta.id,
      ta.strategy_key AS "strategyKey",
      ta.alert_type AS "alertType",
      ta.related_position_id AS "relatedPositionId",
      ta.suggested_structure AS "suggestedStructure",
      ta.rationale,
      ta.status,
      ta.reviewed_at AS "reviewedAt",
      ta.resulting_position_id AS "resultingPositionId",
      ta.created_at AS "createdAt",
      t.id AS "tickerId",
      t.symbol,
      t.company_name AS "companyName",
      t.sector
    FROM trade_alerts ta
    JOIN tickers t ON t.id = ta.ticker_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY t.symbol, (ta.suggested_structure->>'annualizedYield')::numeric DESC
    `,
    params,
  );
  response.json(result.rows);
});

// Only rejection happens directly through this route — approving (with or
// without edits) goes through the normal position-creation flow instead
// (Positions' "+ New Position" form, pre-filled the same way Screener's
// "Trade" button pre-fills it), so the user always confirms/can adjust the
// actual fill price before a position is created from a suggestion. See
// positions.ts's sourceAlertId handling for the other half of that flow.
tradeAlertsRouter.patch("/:id", async (request, response) => {
  const { status } = request.body as { status?: string };
  if (status !== "rejected") {
    response.status(400).json({ error: "Only status: 'rejected' is supported here." });
    return;
  }

  const [updated] = await db("trade_alerts")
    .where({ id: request.params.id, status: "pending" })
    .update({ status: "rejected", reviewed_by_user_id: request.session.userId, reviewed_at: db.fn.now() })
    .returning("*");

  if (!updated) {
    response.status(404).json({ error: "Pending trade alert not found." });
    return;
  }
  response.json(updated);
});
