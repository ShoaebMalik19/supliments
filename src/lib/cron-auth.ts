import { timingSafeEqual } from "node:crypto";

/** Bearer CRON_SECRET check shared by scheduler-facing routes. Callers answer 404 on failure. */
export function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${secret}`;
  return (
    !!secret && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
  );
}
