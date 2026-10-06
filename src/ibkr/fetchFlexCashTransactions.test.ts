import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  workerRow: undefined as { ibkr_account_ids: string[] | null; updated_at: string | Date } | undefined,
  queries: [] as { table: string; condition: unknown; columns: unknown[] }[],
}));
vi.mock("../db/connection.js", () => ({
  db: (table: string) => ({
    where: (condition: unknown) => ({
      first: async (...columns: unknown[]) => {
        database.queries.push({ table, condition, columns });
        return database.workerRow;
      },
    }),
  }),
}));

import { fetchFlexCashTransactions } from "./fetchFlexCashTransactions.js";
import { workerHeartbeatAlertAfterMs } from "../lib/workerHeartbeatLiveness.js";

const fixedNow = new Date("2026-10-06T23:00:00Z");
const fetchMock = vi.fn();

type FetchStep = { body: string } | { error: Error };
let steps: FetchStep[] = [];

function queueResponses(...bodies: string[]): void {
  steps = bodies.map((body) => ({ body }));
}

const sendRequestSuccess = (referenceCode = "9876543210") =>
  `<FlexStatementResponse timestamp="06 October, 2026 06:59 PM EDT"><Status>Success</Status><ReferenceCode>${referenceCode}</ReferenceCode><Url>https://example.invalid/GetStatement</Url></FlexStatementResponse>`;
const sendRequestFailure = (errorCode: string | null, errorMessage: string | null, status = "Fail") =>
  `<FlexStatementResponse><Status>${status}</Status>${errorCode === null ? "" : `<ErrorCode>${errorCode}</ErrorCode>`}${errorMessage === null ? "" : `<ErrorMessage>${errorMessage}</ErrorMessage>`}</FlexStatementResponse>`;
const rateLimited = sendRequestFailure("1018", "Too many requests have been made from this token. Please try again shortly.");
// IBKR sends ErrorCode as an element (see the it.fails cases); the polling-loop cases use the attribute form because
// the XML parser turns an element's digits into a number, which the loop's string comparison never matches.
const stillGenerating = '<FlexStatementResponse ErrorCode="1019"><Status>Warn</Status><ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage></FlexStatementResponse>';
const stillGeneratingAsIbkrSendsIt = sendRequestFailure("1019", "Statement generation in progress. Please try again shortly.", "Warn");

const statementXml = (accountId: string | null, sections = "") => `<FlexStatement${accountId === null ? "" : ` accountId="${accountId}"`} fromDate="20260906" toDate="20261005">${sections}</FlexStatement>`;
const reportXml = (...statements: string[]) => `<FlexQueryResponse queryName="Cash" type="AF"><FlexStatements count="${statements.length}">${statements.join("")}</FlexStatements></FlexQueryResponse>`;
const cashSection = (...rows: string[]) => `<CashTransactions>${rows.join("")}</CashTransactions>`;
const cashRow = (type: string, amount: string, dateTime: string) => `<CashTransaction type="${type}" amount="${amount}" dateTime="${dateTime}" />`;
const transferSection = (...rows: string[]) => `<Transfers>${rows.join("")}</Transfers>`;

const liveWorker = { ibkr_account_ids: ["U21518308"], updated_at: new Date(fixedNow.getTime() - 30_000) };

/** Drives a call to completion: pending microtasks are flushed first, and the fake clock is advanced only if the call is still waiting on a timer. */
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let outcome: { value?: T; error?: unknown } | undefined;
  promise.then(
    (value) => (outcome = { value }),
    (error) => (outcome = { error }),
  );
  for (let step = 0; step < 20 && !outcome; step++) await vi.advanceTimersByTimeAsync(0);
  for (let step = 0; step < 100 && !outcome; step++) await vi.advanceTimersByTimeAsync(5_000);
  return outcome ?? { error: new Error("did not settle") };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
  fetchMock.mockReset();
  steps = [];
  fetchMock.mockImplementation(async () => {
    const step = steps.shift();
    if (!step) throw new Error("unexpected extra fetch");
    if ("error" in step) throw step.error;
    return { text: async () => step.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("IBKR_FLEX_TOKEN", "tok en/1");
  vi.stubEnv("IBKR_FLEX_QUERY_ID", "1657122");
  database.workerRow = liveWorker;
  database.queries.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchFlexCashTransactions configuration", () => {
  it("fails before any request when the token is missing", async () => {
    vi.stubEnv("IBKR_FLEX_TOKEN", "");
    await expect(fetchFlexCashTransactions()).rejects.toThrow("Missing required environment variable: IBKR_FLEX_TOKEN");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before any request when the query id is missing", async () => {
    vi.stubEnv("IBKR_FLEX_QUERY_ID", "");
    await expect(fetchFlexCashTransactions()).rejects.toThrow("Missing required environment variable: IBKR_FLEX_QUERY_ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchFlexCashTransactions request flow", () => {
  it("sends the URL-encoded token and query, then fetches the statement with the returned reference code", async () => {
    queueResponses(sendRequestSuccess("123456789"), reportXml(statementXml("U21518308")));
    const outcome = await settle(fetchFlexCashTransactions());
    expect(outcome.error).toBeUndefined();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=tok%20en%2F1&q=1657122&v=3",
      "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?t=tok%20en%2F1&q=123456789&v=3",
    ]);
  });

  it("reads the worker's account and heartbeat from worker_health for the ibkr_gateway_worker process", async () => {
    queueResponses(sendRequestSuccess(), reportXml(statementXml("U21518308")));
    await settle(fetchFlexCashTransactions());
    expect(database.queries).toEqual([{ table: "worker_health", condition: { process_name: "ibkr_gateway_worker" }, columns: ["ibkr_account_ids", "updated_at"] }]);
  });

  it("returns no flows for a report for the right account with no cash sections", async () => {
    queueResponses(sendRequestSuccess(), reportXml(statementXml("U21518308")));
    expect((await settle(fetchFlexCashTransactions())).value).toEqual([]);
  });

  describe("SendRequest failures", () => {
    it("fails at once on an ordinary error, quoting IBKR's message, without retrying", async () => {
      queueResponses(sendRequestFailure("1012", "Token has expired."));
      const outcome = await settle(fetchFlexCashTransactions());
      expect((outcome.error as Error).message).toBe("Flex SendRequest failed: Token has expired.");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to the status text, then to 'unknown error', when there is no error message", async () => {
      queueResponses(sendRequestFailure(null, null, "Fail"));
      expect(((await settle(fetchFlexCashTransactions())).error as Error).message).toBe("Flex SendRequest failed: Fail");
      queueResponses("<Unrelated/>");
      expect(((await settle(fetchFlexCashTransactions())).error as Error).message).toBe("Flex SendRequest failed: unknown error");
    });

    it("keeps a reference code with leading zeros intact in the GetStatement request", async () => {
      queueResponses(sendRequestSuccess("0012345678"), reportXml(statementXml("U21518308")));
      await settle(fetchFlexCashTransactions());
      expect(fetchMock.mock.calls[1]![0]).toContain("q=0012345678&");
    });

    it("treats a Success status without a reference code as a failure", async () => {
      queueResponses("<FlexStatementResponse><Status>Success</Status></FlexStatementResponse>");
      expect(((await settle(fetchFlexCashTransactions())).error as Error).message).toBe("Flex SendRequest failed: Success");
    });

    it("does not retry a network failure of the request itself", async () => {
      steps = [{ error: new Error("socket hang up") }];
      expect(((await settle(fetchFlexCashTransactions())).error as Error).message).toBe("socket hang up");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("rate-limit retry", () => {
    it("waits 45 s and retries once after error code 1018, then succeeds", async () => {
      queueResponses(rateLimited, sendRequestSuccess(), reportXml(statementXml("U21518308")));
      const pending = fetchFlexCashTransactions();
      let done = false;
      void pending.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(44_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await pending;
      expect(done).toBe(true);
      expect(console.warn).toHaveBeenCalledWith("Flex SendRequest was rate limited (attempt 1 of 3); retrying in 45s.");
    });

    it("recognises the throttle by its message when the error code is missing", async () => {
      queueResponses(sendRequestFailure(null, "Too many requests have been made from this token."), sendRequestSuccess(), reportXml(statementXml("U21518308")));
      const outcome = await settle(fetchFlexCashTransactions());
      expect(outcome.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("recognises the throttle by its code alone, sent as an element with no recognisable message", async () => {
      queueResponses(sendRequestFailure("1018", "Slow down."), sendRequestSuccess(), reportXml(statementXml("U21518308")));
      const outcome = await settle(fetchFlexCashTransactions());
      expect(outcome.error).toBeUndefined();
    });

    it("gives up after 3 attempts and rethrows the throttle error unchanged, having waited 45 s twice", async () => {
      queueResponses(rateLimited, rateLimited, rateLimited);
      const startedAt = Date.now();
      const pending = fetchFlexCashTransactions();
      const captured = pending.catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(90_000);
      const error = (await captured) as Error;
      expect(error.message).toBe("Flex SendRequest failed: Too many requests have been made from this token. Please try again shortly.");
      expect(error.name).toBe("FlexRateLimitError");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(Date.now() - startedAt).toBe(90_000);
      expect(console.warn).toHaveBeenCalledTimes(2);
      expect(console.warn).toHaveBeenNthCalledWith(2, "Flex SendRequest was rate limited (attempt 2 of 3); retrying in 45s.");
    });

    it("stops retrying as soon as a non-throttle error arrives", async () => {
      queueResponses(rateLimited, sendRequestFailure("1012", "Token has expired."));
      const pending = fetchFlexCashTransactions();
      const captured = pending.catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(((await captured) as Error).message).toBe("Flex SendRequest failed: Token has expired.");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("statement polling", () => {
    it("retries every 5 s while IBKR answers 1019 (still generating), then returns the statement", async () => {
      queueResponses(sendRequestSuccess(), stillGenerating, stillGenerating, reportXml(statementXml("U21518308")));
      const pending = fetchFlexCashTransactions();
      let result: unknown;
      void pending.then((value) => (result = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      await pending;
      expect(result).toEqual([]);
    });

    it("times out after 120 s of 1019 answers with 24 GetStatement attempts", async () => {
      queueResponses(sendRequestSuccess(), ...Array.from({ length: 40 }, () => stillGenerating));
      const captured = fetchFlexCashTransactions().catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(((await captured) as Error).message).toBe("Flex GetStatement timed out waiting for report generation.");
      // One SendRequest plus GetStatement attempts at t = 0, 5, ..., 115 s.
      expect(fetchMock).toHaveBeenCalledTimes(1 + 24);
    });

    it("retries when IBKR sends the 1019 code as an element, as the real service does", async () => {
      queueResponses(sendRequestSuccess(), stillGeneratingAsIbkrSendsIt, reportXml(statementXml("U21518308")));
      const outcome = await settle(fetchFlexCashTransactions());
      expect(outcome.error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("fails at once on any other GetStatement error, with IBKR's message", async () => {
      queueResponses(sendRequestSuccess(), sendRequestFailure("1020", "Invalid request or unable to validate request."));
      const outcome = await settle(fetchFlexCashTransactions());
      expect((outcome.error as Error).message).toBe("Flex GetStatement failed: Invalid request or unable to validate request.");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("uses 'unknown error' when the GetStatement failure has no message", async () => {
      queueResponses(sendRequestSuccess(), sendRequestFailure("1020", null));
      expect(((await settle(fetchFlexCashTransactions())).error as Error).message).toBe("Flex GetStatement failed: unknown error");
    });

    it("never reads the worker row while the report is not ready", async () => {
      queueResponses(sendRequestSuccess(), sendRequestFailure("1020", "bad"));
      await settle(fetchFlexCashTransactions());
      expect(database.queries).toEqual([]);
    });
  });
});

describe("assertStatementsAreForWorkerAccount (fail closed)", () => {
  async function runWith(report: string): Promise<{ value?: unknown; error?: unknown }> {
    queueResponses(sendRequestSuccess(), report);
    return settle(fetchFlexCashTransactions());
  }
  const refusal = (outcome: { error?: unknown }) => (outcome.error as Error | undefined)?.message;

  it("accepts a report whose account is one of the worker's accounts", async () => {
    database.workerRow = { ibkr_account_ids: ["DU111", "U21518308"], updated_at: new Date(fixedNow.getTime() - 1000) };
    expect((await runWith(reportXml(statementXml("U21518308")))).error).toBeUndefined();
  });

  it("refuses a report for a different account, naming both accounts and returning no flows", async () => {
    const outcome = await runWith(reportXml(statementXml("DUR854038", cashSection(cashRow("Deposits &amp; Withdrawals", "5000", "20261001;100000")))));
    expect(outcome.value).toBeUndefined();
    expect(refusal(outcome)).toBe(
      "Flex report refused: the Flex report is for account DUR854038 but this environment's worker is bound to U21518308; the Flex token and query belong to a different account",
    );
  });

  it("refuses a report with several statements, even when one of them is the right account", async () => {
    expect(refusal(await runWith(reportXml(statementXml("U21518308"), statementXml("U99999999"))))).toBe(
      "Flex report refused: the Flex report contains 2 statements; the query must cover exactly one account",
    );
  });

  it("refuses a report with no statements at all", async () => {
    expect(refusal(await runWith('<FlexQueryResponse queryName="Cash" type="AF"><FlexStatements count="0"/></FlexQueryResponse>'))).toBe(
      "Flex report refused: the Flex report contains 0 statements; the query must cover exactly one account",
    );
  });

  it("refuses a report that does not name its account", async () => {
    expect(refusal(await runWith(reportXml(statementXml(null))))).toBe("Flex report refused: the Flex report does not say which account it is for");
  });

  it("refuses when the worker has never written a worker_health row", async () => {
    database.workerRow = undefined;
    expect(refusal(await runWith(reportXml(statementXml("U21518308"))))).toBe(
      "Flex report refused: the Flex report's account cannot be checked because the worker has never reported its account",
    );
  });

  it("refuses when the worker's heartbeat is stale, and accepts it exactly at the limit", async () => {
    database.workerRow = { ibkr_account_ids: ["U21518308"], updated_at: new Date(fixedNow.getTime() - workerHeartbeatAlertAfterMs - 1) };
    expect(refusal(await runWith(reportXml(statementXml("U21518308"))))).toBe(
      "Flex report refused: the Flex report's account cannot be checked because the worker's last report is stale",
    );
    database.workerRow = { ibkr_account_ids: ["U21518308"], updated_at: new Date(fixedNow.getTime() - workerHeartbeatAlertAfterMs) };
    expect((await runWith(reportXml(statementXml("U21518308")))).error).toBeUndefined();
  });

  it("reads the heartbeat from a string timestamp as well as a Date", async () => {
    database.workerRow = { ibkr_account_ids: ["U21518308"], updated_at: new Date(fixedNow.getTime() - 60_000).toISOString() };
    expect((await runWith(reportXml(statementXml("U21518308")))).error).toBeUndefined();
  });

  it("refuses when the worker reports no accounts (null or empty array)", async () => {
    const expected = "Flex report refused: the Flex report's account cannot be checked because the worker reports no account";
    database.workerRow = { ibkr_account_ids: null, updated_at: new Date(fixedNow.getTime() - 1000) };
    expect(refusal(await runWith(reportXml(statementXml("U21518308"))))).toBe(expected);
    database.workerRow = { ibkr_account_ids: [], updated_at: new Date(fixedNow.getTime() - 1000) };
    expect(refusal(await runWith(reportXml(statementXml("U21518308"))))).toBe(expected);
  });
});

describe("cash flow extraction from the parsed report", () => {
  async function flowsFrom(sections: string): Promise<unknown> {
    queueResponses(sendRequestSuccess(), reportXml(statementXml("U21518308", sections)));
    const outcome = await settle(fetchFlexCashTransactions());
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  it("keeps only Deposits & Withdrawals rows of Cash Transactions, signed, and drops dividends, interest and fees", async () => {
    const flows = await flowsFrom(
      cashSection(
        cashRow("Deposits &amp; Withdrawals", "2500.50", "20260923;101500"),
        cashRow("Dividends", "12.34", "20260923;000000"),
        cashRow("Broker Interest Received", "1.10", "20260924"),
        cashRow("Other Fees", "-3", "20260924"),
        cashRow("Deposits &amp; Withdrawals", "-500", "20260925;143000"),
      ),
    );
    expect(flows).toEqual([
      { isoDate: "2026-09-23", occurredAt: new Date("2026-09-23T14:15:00Z"), amount: 2500.5 },
      { isoDate: "2026-09-25", occurredAt: new Date("2026-09-25T18:30:00Z"), amount: -500 },
    ]);
  });

  it("reads a single cash transaction (not an array) and a date-only timestamp as having no time of day", async () => {
    expect(await flowsFrom(cashSection(cashRow("Deposits &amp; Withdrawals", "100", "20261105")))).toEqual([{ isoDate: "2026-11-05", occurredAt: null, amount: 100 }]);
  });

  it("converts Eastern times to UTC across the November daylight-saving change", async () => {
    const flows = (await flowsFrom(
      cashSection(cashRow("Deposits &amp; Withdrawals", "1", "20261031;223815"), cashRow("Deposits &amp; Withdrawals", "1", "20261102;223815")),
    )) as { occurredAt: Date }[];
    expect(flows.map((flow) => flow.occurredAt.toISOString())).toEqual(["2026-11-01T02:38:15.000Z", "2026-11-03T03:38:15.000Z"]);
  });

  it("skips a Deposits & Withdrawals row with a non-numeric amount", async () => {
    expect(await flowsFrom(cashSection(cashRow("Deposits &amp; Withdrawals", "n/a", "20260923;101500"), cashRow("Deposits &amp; Withdrawals", "7", "20260923;101500")))).toEqual([
      { isoDate: "2026-09-23", occurredAt: new Date("2026-09-23T14:15:00Z"), amount: 7 },
    ]);
  });

  it("reads cash rows of the Transfers section: IN positive, OUT negative, converted to base currency", async () => {
    const flows = await flowsFrom(
      transferSection(
        '<Transfer assetCategory="CASH" direction="IN" cashTransfer="10000" fxRateToBase="1" dateTime="20260923;223815" />',
        '<Transfer assetCategory="CASH" direction="OUT" cashTransfer="-200" fxRateToBase="1.25" dateTime="20260924;090000" />',
        '<Transfer assetCategory="STK" direction="IN" cashTransfer="0" dateTime="20260924;090000" />',
      ),
    );
    expect(flows).toEqual([
      { isoDate: "2026-09-23", occurredAt: new Date("2026-09-24T02:38:15Z"), amount: 10000 },
      { isoDate: "2026-09-24", occurredAt: new Date("2026-09-24T13:00:00Z"), amount: -250 },
    ]);
  });

  it("falls back to the transfer's date attribute and a rate of 1 when no dateTime or rate is present", async () => {
    expect(await flowsFrom(transferSection('<Transfer assetCategory="CASH" direction="IN" cashTransfer="300" date="20260930" />'))).toEqual([{ isoDate: "2026-09-30", occurredAt: null, amount: 300 }]);
  });

  it("combines Cash Transactions and Transfers from the same statement, cash transactions first", async () => {
    const flows = await flowsFrom(
      cashSection(cashRow("Deposits &amp; Withdrawals", "1000", "20260901;100000")) +
        transferSection('<Transfer assetCategory="CASH" direction="IN" cashTransfer="50" dateTime="20260902;100000" />'),
    );
    expect((flows as { amount: number }[]).map((flow) => flow.amount)).toEqual([1000, 50]);
  });

  it("ignores a transfer with an unknown direction or an unusable amount", async () => {
    expect(
      await flowsFrom(
        transferSection(
          '<Transfer assetCategory="CASH" direction="SIDEWAYS" cashTransfer="50" dateTime="20260902;100000" />',
          '<Transfer assetCategory="CASH" direction="IN" cashTransfer="abc" dateTime="20260902;100000" />',
        ),
      ),
    ).toEqual([]);
  });

  it("returns [] for an empty Cash Transactions element", async () => {
    expect(await flowsFrom("<CashTransactions/><Transfers/>")).toEqual([]);
  });
});
