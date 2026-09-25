import { redirect } from "next/navigation";
import { signUp } from "@/modules/auth";

async function action(form: FormData) {
  "use server";
  const res = await signUp({
    email: form.get("email"),
    password: form.get("password"),
    orgName: form.get("orgName"),
  });
  redirect(res.ok ? "/verify-email" : `/signup?error=${encodeURIComponent(res.error)}`);
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main>
      <h1>Create your account</h1>
      {error && <p role="alert">{error}</p>}
      <form action={action}>
        <label>
          Company name <input name="orgName" required minLength={2} />
        </label>
        <label>
          Email <input name="email" type="email" required />
        </label>
        <label>
          Password <input name="password" type="password" required minLength={10} />
        </label>
        <button type="submit">Sign up</button>
      </form>
    </main>
  );
}
