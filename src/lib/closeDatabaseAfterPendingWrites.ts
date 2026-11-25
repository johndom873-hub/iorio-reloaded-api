import { db } from "../db/connection.js";
import { flushPendingStockPriceWrites } from "./priceService.js";

/**
 * Closes the database once the writes still queued in memory have run. Every script and process ends with this
 * instead of a bare `db.destroy()`: a write queued without being awaited (the price service's debounced flush) would
 * otherwise run after the pool is gone and be lost.
 */
export async function closeDatabaseAfterPendingWrites(): Promise<void> {
  await flushPendingStockPriceWrites();
  await db.destroy();
}
