import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Free Bites at Vandy",
  description:
    "Vanderbilt events advertising free food: today's ranked cards, the week's schedule, a campus map, and a walking itinerary.",
  icons: {
    icon: [
      { url: "/favicon.svg?v=beacon-contrast-20261004", type: "image/svg+xml" },
      { url: "/favicon-32.png?v=beacon-contrast-20261004", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png?v=beacon-contrast-20261004", type: "image/png", sizes: "16x16" },
    ],
    shortcut: "/favicon.svg?v=beacon-contrast-20261004",
    apple: "/apple-touch-icon.png?v=beacon-contrast-20261004",
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
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The workspace stylesheet is shared verbatim with the Python reference. */}
        <script dangerouslySetInnerHTML={{ __html: `try{const p=JSON.parse(localStorage.getItem('vfr:preferences')||'{}');if(p.theme==='light'||p.theme==='dark')document.documentElement.dataset.theme=p.theme;}catch{}` }} />
        {/* eslint-disable-next-line @next/next/no-css-tags -- shared stylesheet for server and browser-rendered events */}
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body data-offline="false">{children}</body>
    </html>
  );
}
