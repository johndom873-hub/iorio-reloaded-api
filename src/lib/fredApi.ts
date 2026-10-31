// Sent on every FRED (api.stlouisfed.org) request: the risk-free rate, the macro calendar and the backtest's T-bill
// series. FRED resets requests carrying fetch's default User-Agent ("node") over HTTP/2, which Node 26's fetch uses; a
// named client is answered. No imports, so the backtest engine can use it without loading the database or the env.
export const fredRequestHeaders = { "User-Agent": "iorio-reloaded/1.0" } as const;
