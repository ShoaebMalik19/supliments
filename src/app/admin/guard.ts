import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/modules/admin";
import { HttpError } from "@/lib/http";

export async function adminOrNotFound() {
  try {
    return await requireAdmin();
  } catch (e) {
    if (e instanceof HttpError) notFound();
    throw e;
  }
}

/** Non-empty text fields of a form; empty inputs are omitted so validation treats them as unset. */
export function formFields(form: FormData, names: string[]) {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = form.get(n);
    if (typeof v === "string" && v.trim() !== "") out[n] = v.trim();
  }
  return out;
}

/** Runs an admin form action; validation errors come back to `path` as `?error=`. */
export async function formAction(path: string, fn: () => Promise<unknown>) {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof HttpError) || e.status === 404) throw e;
    error = e.message;
  }
  redirect(error ? `${path}?error=${encodeURIComponent(error)}` : path);
}
