// Genosuke's tools call the app's own existing REST endpoints rather than
// reimplementing route logic — it's just another authenticated client, the
// same way the frontend is. That means every tool automatically inherits
// the real validation, error handling, and live IBKR wiring those routes
// already have, instead of a second, drifting copy of the same logic.
//
// Authenticates as a dedicated service user (see scripts/manage-user.ts)
// rather than impersonating Marce or Juan's personal logins. Node's fetch
// doesn't persist cookies across calls like a browser does, so the session
// cookie from login is captured and replayed manually; a 401 on any
// authenticated call triggers exactly one re-login-and-retry (handles
// session expiry — express-session's cookie maxAge is 7 days — without
// looping forever on a genuinely bad credential).
import type { GenosukeConfig } from "./config.js";

export class GenosukeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class GenosukeApiClient {
  private sessionCookie: string | null = null;

  constructor(private readonly config: GenosukeConfig) {}

  private async login(): Promise<void> {
    const response = await fetch(`${this.config.apiBaseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.config.serviceUsername, password: this.config.serviceUserPassword }),
    });
    if (!response.ok) {
      throw new GenosukeApiError(response.status, `Genosuke service-user login failed: ${await response.text()}`);
    }
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) {
      throw new GenosukeApiError(500, "Genosuke login succeeded but no session cookie was returned.");
    }
    // Only the cookie's name=value pair is needed on the way back out —
    // strip the Set-Cookie attributes (Path, HttpOnly, SameSite, ...).
    this.sessionCookie = setCookie.split(";")[0] ?? null;
  }

  private async requestOnce(path: string, init: RequestInit): Promise<Response> {
    if (!this.sessionCookie) await this.login();
    return fetch(`${this.config.apiBaseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, Cookie: this.sessionCookie! },
    });
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response = await this.requestOnce(path, init);
    if (response.status === 401) {
      this.sessionCookie = null;
      response = await this.requestOnce(path, init);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new GenosukeApiError(response.status, `${init.method ?? "GET"} ${path} → ${response.status}: ${body}`);
    }
    if (response.status === 204) return undefined as T;
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
