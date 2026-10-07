import { db } from "../db/connection.js";
import { fetchPositionEventsForPositions, type PositionEvent, type PositionEventLeg } from "./positionEvents.js";
import { fetchPositionById } from "./positionQueries.js";
import { formatSignedDollars } from "./formatSignedDollars.js";
import { formatSignedPercent } from "./formatSignedPercent.js";
import { describeTradeContract, describeTradeLine, labelStrategy } from "./tradeMessageFormatting.js";

// Trading-events catch-all, position side (approved 2026-10-07): every position opening and closing is told once to the
// alerts chat, including the leftover-stock positions the dashboard feed hides. A close the expiry message already told
// (notifyPositionExpired marks telegram_closed_notified_at) is not repeated. Runs in the worker right after each
// reconciliation pass, so it reads positions only once the pass has finished changing them.

const unstructuredReasonLabels: Record<string, string> = {
  csp_assigned_stock: "left over from a put assignment",
  cc_expired_leftover_stock: "left over after a covered call expired",
  manual_stock_buy: "bought outside a strategy",
  other: "other",
  unknown: "reason unknown",
};

const closeReasonLabels: Record<string, string> = {
  assigned: "assigned",
  expired_worthless: "expired worthless",
  stock_rolled_into_covered_call: "shares moved into a covered call",
  closed_via_app: "closed in the app",
  closed_via_external_trade: "closed outside the app",
  unknown: "reason unknown",
};

/** The position's strategy; a leftover-stock position also says why it exists, when that is the event being told. */
function describePositionSubject(event: PositionEvent, unstructuredReason: string | null): string {
  if (event.strategyKey !== "unstructured") return `${event.symbol} ${labelStrategy(event.strategyKey)}`;
  const reason = unstructuredReason ? unstructuredReasonLabels[unstructuredReason] ?? unstructuredReason : null;
  return `${event.symbol} stock, no strategy${reason ? ` (${reason})` : ""}`;
}

/** Pure: "📥 New position: …" with each leg as it was opened (a short leg was sold, a long leg bought). */
export function describePositionOpenedNotice(event: PositionEvent): string {
  const lines = event.legs.map((leg: PositionEventLeg) => describeTradeLine(leg.side === "short" ? "SELL" : "BUY", leg, leg.entryPrice));
  return [`📥 New position: ${describePositionSubject(event, event.unstructuredReason)}`, ...lines].join("\n");
}

/** Pure: "📤 Position closed: …" with each leg as it was closed (a short leg bought back, a long leg sold) and the realized P&L. */
export function describePositionClosedNotice(event: PositionEvent, capitalDeployed: number | null): string {
  const reasonLabel = event.closeReason ? closeReasonLabels[event.closeReason] : undefined;
  const headline = `📤 Position closed: ${describePositionSubject(event, null)}${reasonLabel ? ` — ${reasonLabel}` : ""}`;
  const lines = event.legs.map((leg: PositionEventLeg) =>
    leg.sharesHandedOn ? `• ${describeTradeContract(leg)} moved to the next position` : describeTradeLine(leg.side === "short" ? "BUY" : "SELL", leg, leg.exitPrice),
  );
  // Same P&L % base as the expiry message: realized P&L over capitalDeployed (approved 2026-10-01). A zero P&L has no sign,
  // like its 0.00%.
  const pnlDollars = event.realizedPnl === null ? null : formatSignedDollars(event.realizedPnl, 2, Math.abs(event.realizedPnl) >= 0.005);
  const pnlLine =
    event.realizedPnl === null
      ? "P&L: unknown (an exit price is missing)"
      : capitalDeployed
        ? `P&L: ${pnlDollars} (${formatSignedPercent((event.realizedPnl / capitalDeployed) * 100, 2)})`
        : `P&L: ${pnlDollars}`;
  return [headline, ...lines, pnlLine].join("\n");
}

interface PositionNeedingNotice {
  id: string;
  openedNeedsNotice: boolean;
  closedNeedsNotice: boolean;
  /** An order that opened one of its legs is still working: the legs may grow lot by lot. */
  openingOrderWorking: boolean;
}

/**
 * Tells the chat about every position whose opening or closing it has not been told yet; the opening first. The first
 * undelivered message ends the pass, leaving it and the rest for the next one, so a Telegram outage costs one failed send
 * per reconciliation instead of one per position. Never throws: a notice failure must not break reconciliation.
 */
export async function sendDuePositionTelegramNotices(send: (message: string) => Promise<boolean>): Promise<number> {
  let sent = 0;
  try {
    const positions: PositionNeedingNotice[] = await db("positions")
      .whereNull("telegram_opened_notified_at")
      .orWhere((query) => query.whereNotNull("closed_at").whereNull("telegram_closed_notified_at"))
      .orderBy("opened_at")
      .select(
        "id",
        db.raw('telegram_opened_notified_at IS NULL AS "openedNeedsNotice"'),
        db.raw('(closed_at IS NOT NULL AND telegram_closed_notified_at IS NULL) AS "closedNeedsNotice"'),
        db.raw(`EXISTS (
          SELECT 1 FROM trades tr
          JOIN position_legs pl ON pl.id = tr.position_leg_id
          JOIN order_requests orq ON orq.id = tr.source_order_request_id
          WHERE pl.position_id = positions.id AND NOT tr.is_closing_trade AND orq.status IN ('submitted', 'partially_filled')
        ) AS "openingOrderWorking"`),
      );
    if (positions.length === 0) return 0;

    const events = await fetchPositionEventsForPositions(positions.map((position) => position.id));
    for (const position of positions) {
      try {
        const positionEvents = events.filter((event) => event.positionId === position.id);
        const openedEvent = positionEvents.find((event) => event.eventType === "opened" || event.eventType === "unstructured");
        const closedEvent = positionEvents.find((event) => event.eventType === "closed");

        // Told once its opening order has finished, so an order filled lot by lot is told at its full size.
        if (position.openedNeedsNotice && position.openingOrderWorking) continue;
        if (position.openedNeedsNotice && openedEvent) {
          if (!(await send(describePositionOpenedNotice(openedEvent)))) return sent;
          await db("positions").where({ id: position.id }).update({ telegram_opened_notified_at: db.fn.now() });
          sent += 1;
        }
        if (position.closedNeedsNotice && closedEvent) {
          const details = await fetchPositionById(position.id);
          const capitalDeployed = details?.capitalDeployed == null ? null : Number(details.capitalDeployed);
          if (!(await send(describePositionClosedNotice(closedEvent, capitalDeployed)))) return sent;
          await db("positions").where({ id: position.id }).update({ telegram_closed_notified_at: db.fn.now() });
          sent += 1;
        }
      } catch (error) {
        console.error(`Position Telegram notice failed for position ${position.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    console.error(`Position Telegram notice pass failed: ${error instanceof Error ? error.message : error}`);
  }
  return sent;
}
