import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { assignFlowsToSnapshots, cashFlowFromTransferRow, extractExternalCashFlows, parseFlexDateTime, type FlexCashFlow, type SnapshotCaptureTime } from "./flexCashFlowAssignment.js";

// The live account's real transfer row (Flex "Transfers" section, 2026-10-02 probe).
const liveTransferRow = {
  fxRateToBase: "1",
  assetCategory: "CASH",
  date: "20260923",
  dateTime: "20260923;223815",
  type: "INTERNAL",
  direction: "IN",
  positionAmount: "0",
  cashTransfer: "100000",
};

const snapshot = (snapshotDate: string, capturedAtUtc: string): SnapshotCaptureTime => ({ snapshotDate, capturedAt: new Date(capturedAtUtc) });
const flow = (dateTime: string, amount: number): FlexCashFlow => ({ ...parseFlexDateTime(dateTime), amount });

describe("parseFlexDateTime", () => {
  it("reads the time as US Eastern (EDT in September)", () => {
    const parsed = parseFlexDateTime("20260923;223815");
    expect(parsed.isoDate).toBe("2026-09-23");
    expect(parsed.occurredAt?.toISOString()).toBe("2026-09-24T02:38:15.000Z");
  });
  it("reads EST in winter", () => {
    expect(parseFlexDateTime("20270115;093000").occurredAt?.toISOString()).toBe("2027-01-15T14:30:00.000Z");
  });
  it("has no instant when the timestamp carries no time of day", () => {
    expect(parseFlexDateTime("20260923")).toEqual({ isoDate: "2026-09-23", occurredAt: null });
  });
});

describe("cashFlowFromTransferRow", () => {
  it("turns the live transfer in into a +100,000 flow", () => {
    const parsed = cashFlowFromTransferRow(liveTransferRow);
    expect(parsed?.amount).toBe(100_000);
    expect(parsed?.isoDate).toBe("2026-09-23");
  });
  it("makes a transfer out negative whatever sign the amount arrives with", () => {
    expect(cashFlowFromTransferRow({ ...liveTransferRow, direction: "OUT" })?.amount).toBe(-100_000);
    expect(cashFlowFromTransferRow({ ...liveTransferRow, direction: "OUT", cashTransfer: "-100000" })?.amount).toBe(-100_000);
  });
  it("converts to the base currency", () => {
    expect(cashFlowFromTransferRow({ ...liveTransferRow, cashTransfer: "1000", fxRateToBase: "1.1" })?.amount).toBeCloseTo(1_100, 9);
  });
  it("leaves rows that move securities, or are unreadable, alone", () => {
    expect(cashFlowFromTransferRow({ ...liveTransferRow, assetCategory: "STK" })).toBeNull();
    expect(cashFlowFromTransferRow({ ...liveTransferRow, direction: undefined })).toBeNull();
    expect(cashFlowFromTransferRow({ ...liveTransferRow, cashTransfer: "n/a" })).toBeNull();
  });
});

describe("assignFlowsToSnapshots", () => {
  const snapshots = [
    snapshot("2026-09-22", "2026-09-22T22:31:00Z"),
    snapshot("2026-09-23", "2026-09-23T22:31:00Z"),
    snapshot("2026-09-24", "2026-09-24T22:31:00Z"),
  ];

  it("files the live 22:38 ET transfer under the next snapshot, not under its own date", () => {
    const assigned = assignFlowsToSnapshots([flow("20260923;223815", 100_000)], snapshots);
    expect([...assigned]).toEqual([["2026-09-24", 100_000]]);
  });

  it("files a flow before a snapshot's capture under that snapshot's date", () => {
    // 16:00 ET on the 23rd is before the 18:30 ET capture.
    expect([...assignFlowsToSnapshots([flow("20260923;160000", 5_000)], snapshots)]).toEqual([["2026-09-23", 5_000]]);
  });

  it("switches exactly at the capture time", () => {
    const capture = snapshot("2026-09-23", "2026-09-23T22:31:00Z"); // 18:31:00 ET
    const justBefore = assignFlowsToSnapshots([flow("20260923;183059", 1)], [capture, snapshot("2026-09-24", "2026-09-24T22:31:00Z")]);
    const justAfter = assignFlowsToSnapshots([flow("20260923;183101", 1)], [capture, snapshot("2026-09-24", "2026-09-24T22:31:00Z")]);
    expect([...justBefore.keys()]).toEqual(["2026-09-23"]);
    expect([...justAfter.keys()]).toEqual(["2026-09-24"]);
  });

  it("sums several flows on one snapshot", () => {
    const assigned = assignFlowsToSnapshots([flow("20260923;100000", 1_000), flow("20260923;120000", -400)], snapshots);
    expect(assigned.get("2026-09-23")).toBe(600);
  });

  it("leaves out a flow after the latest snapshot, for the next night", () => {
    expect(assignFlowsToSnapshots([flow("20260924;223000", 7)], snapshots).size).toBe(0);
  });

  it("uses the flow's own date when it carries no time", () => {
    expect([...assignFlowsToSnapshots([flow("20260923", 50)], snapshots)]).toEqual([["2026-09-23", 50]]);
  });

  it("gives a flow older than every snapshot to the oldest one", () => {
    expect([...assignFlowsToSnapshots([flow("20260901;120000", 9)], snapshots)]).toEqual([["2026-09-22", 9]]);
  });
});

describe("extractExternalCashFlows", () => {
  // The shape of the live report (2026-10-02 probe), parsed the way the fetcher parses it.
  const liveReportXml = `<FlexQueryResponse><FlexStatements count="1"><FlexStatement accountId="U0000000">
    <CashTransactions>
      <CashTransaction currency="USD" description="FEE" dateTime="20260930;170121" amount="-4.5" type="Other Fees" transactionID="1" />
      <CashTransaction currency="USD" description="FEE" dateTime="20260930;170121" amount="-10" type="Other Fees" transactionID="2" />
    </CashTransactions>
    <Transfers>
      <Transfer fxRateToBase="1" assetCategory="CASH" date="20260923" dateTime="20260923;223815" type="INTERNAL" direction="IN" positionAmount="0" cashTransfer="100000" currency="USD" />
    </Transfers>
  </FlexStatement></FlexStatements></FlexQueryResponse>`;
  const parse = (xml: string) => {
    const body = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" }).parse(xml);
    return [body.FlexQueryResponse.FlexStatements.FlexStatement].flat();
  };

  it("reads the transfer and ignores fees", () => {
    const flows = extractExternalCashFlows(parse(liveReportXml));
    expect(flows).toHaveLength(1);
    expect(flows[0]?.amount).toBe(100_000);
    expect(flows[0]?.occurredAt?.toISOString()).toBe("2026-09-24T02:38:15.000Z");
  });

  it("reads a Deposits & Withdrawals row, one or many, and a report with neither section", () => {
    const single = parse(`<FlexQueryResponse><FlexStatements><FlexStatement><CashTransactions><CashTransaction type="Deposits &amp; Withdrawals" amount="2500" dateTime="20260925;101500" /></CashTransactions></FlexStatement></FlexStatements></FlexQueryResponse>`);
    expect(extractExternalCashFlows(single).map((flowRow) => flowRow.amount)).toEqual([2_500]);
    const many = parse(`<FlexQueryResponse><FlexStatements><FlexStatement><CashTransactions><CashTransaction type="Deposits &amp; Withdrawals" amount="2500" dateTime="20260925;101500" /><CashTransaction type="Deposits &amp; Withdrawals" amount="-500" dateTime="20260926;101500" /></CashTransactions></FlexStatement></FlexStatements></FlexQueryResponse>`);
    expect(extractExternalCashFlows(many).map((flowRow) => flowRow.amount)).toEqual([2_500, -500]);
    expect(extractExternalCashFlows(parse(`<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1"></FlexStatement></FlexStatements></FlexQueryResponse>`))).toEqual([]);
  });

  it("does not hand a securities transfer to the performance maths", () => {
    const stock = parse(`<FlexQueryResponse><FlexStatements><FlexStatement><Transfers><Transfer assetCategory="STK" direction="IN" positionAmount="5000" cashTransfer="0" dateTime="20260925;101500" /></Transfers></FlexStatement></FlexStatements></FlexQueryResponse>`);
    expect(extractExternalCashFlows(stock)).toEqual([]);
  });
});
