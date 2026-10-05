// IBKR throttles each Flex token ("Too many requests have been made from this token. Please try again
// shortly."), so one refused request is usually gone a minute later. Only that error is retried: any other
// Flex failure (bad token, bad query, a report problem) fails at once, and the last rate-limit error is
// rethrown unchanged so the job's alert text stays the same when every attempt is refused.

export const flexRateLimitMaxAttempts = 3;
export const flexRateLimitRetryDelayMs = 45_000;

export class FlexRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlexRateLimitError";
  }
}

/** IBKR's error code for the per-token throttle is 1018; the message is matched too in case the code is missing. */
export function isFlexRateLimitResponse(errorCode: string | undefined, errorMessage: string | undefined): boolean {
  return errorCode === "1018" || /too many requests/i.test(errorMessage ?? "");
}

export interface FlexRateLimitRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRetry?: (details: { attempt: number; maxAttempts: number; delayMs: number; error: FlexRateLimitError }) => void;
}

export async function retryOnFlexRateLimit<Result>(operation: () => Promise<Result>, options: FlexRateLimitRetryOptions = {}): Promise<Result> {
  const maxAttempts = options.maxAttempts ?? flexRateLimitMaxAttempts;
  const delayMs = options.delayMs ?? flexRateLimitRetryDelayMs;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof FlexRateLimitError) || attempt >= maxAttempts) throw error;
      options.onRetry?.({ attempt, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}
