import type { Instrumentation } from "next";

/**
 * Every unhandled server error is logged as one JSON line (Vercel keeps runtime logs; a log drain
 * or an error-tracking vendor can consume them). Messages only: no request bodies or headers.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const e = err as Error & { digest?: string };
  console.error(
    JSON.stringify({
      level: "error",
      event: "request_error",
      message: String(e?.message ?? err).slice(0, 500),
      digest: e?.digest ?? null,
      method: request.method,
      path: request.path.split("?")[0],
      routePath: context.routePath,
      routeType: context.routeType,
    }),
  );
};
