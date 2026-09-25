export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, "Not found");
export const unauthorized = () => new HttpError(401, "Unauthorized");
export const forbidden = () => new HttpError(403, "Forbidden");
export const badRequest = (msg = "Bad request") => new HttpError(400, msg);

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
}

/** JSON response that serializes bigint (money minor units) as strings, never as floats. */
export function json(body: unknown, init?: ResponseInit): Response {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(text, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}
