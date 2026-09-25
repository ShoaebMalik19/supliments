import { redirect } from "next/navigation";
import { resetPassword } from "@/modules/auth";

async function action(form: FormData) {
  "use server";
  const res = await resetPassword(String(form.get("password") ?? ""));
  redirect(res.ok ? "/dashboard" : `/reset-password?error=${encodeURIComponent(res.error)}`);
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main>
      <h1>Choose a new password</h1>
      {error && <p role="alert">{error}</p>}
      <form action={action}>
        <label>
          New password <input name="password" type="password" required minLength={10} />
        </label>
        <button type="submit">Update password</button>
      </form>
    </main>
  );
}
