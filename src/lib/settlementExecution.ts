// IBKR records an option's expiry or assignment as executions with no order behind them (order id 0): the option at $0
// (exec id group suffix .01 when it lapsed, .03 when it was assigned) and, for an assignment, the stock at the strike.
// Since 2026-10-16 the worker saves them as closing trades. The option's $0 record is a settlement, not a trade: it
// neither buys the option back nor tells whether it was assigned, so every "was this leg closed by a trade?" check
// leaves it out (Marcelo 2026-11-02). The stock fill keeps counting: it is a real sale or purchase of shares.

/** SQL boolean: the trades row aliased `tradesAlias` is IBKR's $0 settlement record of an expired or assigned option. */
export function ibkrSettlementExecutionSql(tradesAlias: string): string {
  return `(${tradesAlias}.price = 0 AND ${tradesAlias}.source_order_request_id IS NULL AND coalesce(${tradesAlias}.ibkr_order_id, '') = '0')`;
}

/** SQL boolean: the trades row aliased `tradesAlias` is a closing trade other than an IBKR settlement record. */
export function closingTradeOtherThanSettlementSql(tradesAlias: string): string {
  return `(${tradesAlias}.is_closing_trade AND NOT ${ibkrSettlementExecutionSql(tradesAlias)})`;
}
