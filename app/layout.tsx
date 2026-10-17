import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Inkstaff", template: "%s · Inkstaff" },
  description: "A team of AI agents that research, write, illustrate and review blog articles.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background font-sans text-foreground">
        <header className="border-b">
          <nav className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-sm sm:px-8" aria-label="Main">
            <Link href="/" className="font-semibold tracking-tight">
              Inkstaff
            </Link>
            <Link href="/" className="text-muted-foreground hover:text-foreground">
              Articles
            </Link>
            <Link href="/products" className="text-muted-foreground hover:text-foreground">
              Products
            </Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
