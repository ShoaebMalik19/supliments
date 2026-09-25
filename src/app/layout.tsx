import type { ReactNode } from "react";

export const metadata = { title: "Private Label Platform" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
