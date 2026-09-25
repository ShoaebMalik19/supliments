import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Private Label Platform</h1>
      <p>
        <Link href="/signup">Sign up</Link> · <Link href="/login">Log in</Link>
      </p>
    </main>
  );
}
