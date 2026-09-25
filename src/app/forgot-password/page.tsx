import { redirect } from "next/navigation";
import { requestPasswordReset } from "@/modules/auth";

async function action(form: FormData) {
  "use server";
  await requestPasswordReset(String(form.get("email") ?? ""));
  redirect("/forgot-password?sent=1");
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { sent } = await searchParams;
  return (
    <main>
      <h1>Reset your password</h1>
      {sent ? (
        <p>If an account exists for that email, a reset link is on its way.</p>
      ) : (
        <form action={action}>
          <label>
            Email <input name="email" type="email" required />
          </label>
          <button type="submit">Send reset link</button>
        </form>
      )}
    </main>
  );
}
