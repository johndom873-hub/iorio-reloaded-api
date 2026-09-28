// Genosuke's service-user client is the shared InternalApiClient (lib/internalApiClient.ts,
// generalized 2026-09-28 so Pluto's executor uses the same one) bound to Genosuke's config.
// Kept as a named class so the tool modules and tests keep their imports.
import { InternalApiClient, InternalApiError } from "../lib/internalApiClient.js";
import type { GenosukeConfig } from "./config.js";

export { InternalApiError as GenosukeApiError };

export class GenosukeApiClient extends InternalApiClient {
  constructor(config: Pick<GenosukeConfig, "apiBaseUrl" | "serviceUsername" | "serviceUserPassword">) {
    super({ apiBaseUrl: config.apiBaseUrl, serviceUsername: config.serviceUsername, serviceUserPassword: config.serviceUserPassword, label: "Genosuke" });
  }
}
