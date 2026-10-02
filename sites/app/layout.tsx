import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vandy Food Radar",
  description:
    "Vanderbilt events advertising free food: today's ranked cards, the week's schedule, a campus map, and a walking itinerary.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/* The workspace stylesheet is shared verbatim with the Python reference. */}
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body data-offline="false">{children}</body>
    </html>
  );
}
