import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn } from "@/modules/auth";

async function action(form: FormData) {
  "use server";
  const res = await signIn(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  redirect(res.ok ? "/dashboard" : `/login?error=${encodeURIComponent(res.error)}`);
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main>
      <h1>Log in</h1>
      {error && <p role="alert">{error === "link" ? "That link is invalid or expired." : error}</p>}
      <form action={action}>
        <label>
          Email <input name="email" type="email" required />
        </label>
        <label>
          Password <input name="password" type="password" required />
        </label>
        <button type="submit">Log in</button>
      </form>
      <p>
        <Link href="/forgot-password">Forgot password?</Link> · <Link href="/signup">Sign up</Link>
      </p>
    </main>
  );
}
