// A service-user client for the app's own REST API, shared by every bot (Genosuke's Telegram
// tools, Pluto's executor). Bots call the real routes rather than reimplementing route logic,
// so every tool automatically inherits the real validation, gates and IBKR wiring those routes
// already have, instead of a second, drifting copy of the same logic.
//
// Authenticates as a dedicated service user (see scripts/manage-user.ts) rather than
// impersonating Marce or Juan's personal logins. Node's fetch doesn't persist cookies across
// calls like a browser does, so the session cookie from login is captured and replayed
// manually; a 401 on any authenticated call triggers exactly one re-login-and-retry (handles
// session expiry — express-session's cookie maxAge is 30 days — without looping forever on a
// genuinely bad credential).

export interface InternalApiClientConfig {
  /** Loopback for a bot living in the web dyno; the public API origin for a bot on its own dyno. */
  apiBaseUrl: string;
  serviceUsername: string;
  serviceUserPassword: string;
  /** Sent as X-Service-Login-Secret by a bot that reaches the API through the router (serviceLoginSecret.ts); loopback bots omit it. */
  serviceLoginSecret?: string;
  /** Name used in log lines and error messages, e.g. "Genosuke" or "Pluto". */
  label: string;
}

export class InternalApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class InternalApiClient {
  private sessionCookie: string | null = null;
  // Callers run in parallel (Promise.all) — without this, several cold callers each log in,
  // and a 401 on one nulls the cookie the others are about to send.
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly config: InternalApiClientConfig) {}

  private login(): Promise<string> {
    this.loginInFlight ??= this.performLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async performLogin(): Promise<string> {
    const response = await fetch(`${this.config.apiBaseUrl}/auth/login`, {
      method: "POST",
      // middleware/session.ts sets cookie.secure=true in production, and express-session
      // silently refuses to issue a Secure-flagged cookie over what it sees as a plain-HTTP
      // connection. Real browser traffic gets marked secure via Heroku's router adding
      // X-Forwarded-Proto, which app.ts's trust-proxy setting honors — a loopback call bypasses
      // the router, so without this header Express drops the Set-Cookie entirely. Harmless for
      // a call that really does travel over https.
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https", ...(this.config.serviceLoginSecret ? { "X-Service-Login-Secret": this.config.serviceLoginSecret } : {}) },
      body: JSON.stringify({ username: this.config.serviceUsername, password: this.config.serviceUserPassword }),
    });
    if (!response.ok) {
      throw new InternalApiError(response.status, `${this.config.label} service-user login failed: ${await response.text()}`);
    }
    // Read the whole body BEFORE using the cookie: express-session sends every byte of a login
    // response except the last immediately, and holds that last byte until the session is saved
    // to Postgres. fetch() resolves on headers, so skipping this made the very first request
    // after a dyno restart race the save and get a 401 (verified on staging 2026-09-22).
    await response.text();
    const [setCookie] = response.headers.getSetCookie();
    if (!setCookie) throw new InternalApiError(500, `${this.config.label} login succeeded but no session cookie was returned.`);
    const cookie = setCookie.split(";")[0];
    if (!cookie) throw new InternalApiError(500, `${this.config.label} login returned an empty session cookie.`);
    this.sessionCookie = cookie;
    return cookie;
  }

  private async requestOnce(path: string, init: RequestInit): Promise<Response> {
    const cookie = this.sessionCookie ?? (await this.login());
    return fetch(`${this.config.apiBaseUrl}${path}`, { ...init, headers: { ...init.headers, Cookie: cookie } });
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response = await this.requestOnce(path, init);
    if (response.status === 401) {
      console.warn(`${this.config.label} API: 401 on ${init.method ?? "GET"} ${path} (cookie ${this.sessionCookie ? "present" : "absent"}) — re-logging in`);
      this.sessionCookie = null;
      response = await this.requestOnce(path, init);
      if (response.status === 401) console.error(`${this.config.label} API: 401 persisted on ${init.method ?? "GET"} ${path} after a fresh login`);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new InternalApiError(response.status, `${init.method ?? "GET"} ${path} → ${response.status}: ${body}`);
    }
    if (response.status === 204) return undefined as T;
    // Routes that can outlast Heroku's router timeout answer as a stream (lib/streamedResponse.ts):
    // heartbeats, then one final `data:` frame carrying the status and body a JSON route would have sent.
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await response.text();
      const finalFrame = text.split("\n").filter((line) => line.startsWith("data: ")).at(-1);
      if (!finalFrame) throw new InternalApiError(502, `${init.method ?? "GET"} ${path} → stream ended without a result`);
      const result = JSON.parse(finalFrame.slice("data: ".length)) as { status: number; body: unknown };
      if (result.status >= 400) throw new InternalApiError(result.status, `${init.method ?? "GET"} ${path} → ${result.status}: ${JSON.stringify(result.body)}`);
      return result.body as T;
    }
    return (await response.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }
}
