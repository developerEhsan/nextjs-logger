import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { LoggerProvider } from "@developerehsan/nextjs-logger/provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "nextjs-logger demo",
  description: "Live demo of every @developerehsan/nextjs-logger feature",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/*
          Mounted ONCE, near the root — this is the entire client-side setup.
          It's an async Server Component: it mints a signed session token
          server-side and threads it down to a tiny client bootstrap
          component that wires up the relay transport during render (no
          useEffect). Every `log.*()` call anywhere below this, including at
          module/render scope, works immediately with zero further setup.
          `debug` surfaces relay transport diagnostics in the browser
          DevTools console (never your actual log content — that only ever
          goes to the terminal).
        */}
        <LoggerProvider debug>{children}</LoggerProvider>
      </body>
    </html>
  );
}
