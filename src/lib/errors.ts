/**
 * Uniform HTTP errors. The mobile client reads `message` off any non-2xx body
 * (see eko_telehealth/src/api/client.ts), so every thrown error carries one.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Thrown when a route needs an external service whose keys aren't set yet.
 * Maps to 503 so the app shows a clear "not available" state rather than a
 * crash — the mock-first equivalent for the server side.
 */
export class ServiceNotConfiguredError extends HttpError {
  constructor(service: string) {
    super(503, `${service} is not configured yet. Add its credentials to the environment to enable this endpoint.`);
    this.name = 'ServiceNotConfiguredError';
  }
}
