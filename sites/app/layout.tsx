import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vandy Food Radar",
  description:
    "Ranked Vanderbilt events advertising free food, cross-checked against their source and refreshed on demand.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
