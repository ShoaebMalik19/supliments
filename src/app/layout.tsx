import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = { title: "Private Label Platform" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <footer>
          <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>
        </footer>
      </body>
    </html>
  );
}
