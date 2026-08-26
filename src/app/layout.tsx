import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

import { BRAND } from "@/lib/brand";
import { QueryProvider } from "@/components/providers/query-provider";
import { ThemeProvider, ThemeScript } from "@/components/providers/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * The root layout is deliberately thin.
 *
 * It holds only what EVERY page needs — fonts, theme, the query client, the
 * toaster — and no longer renders the application shell or the analysis
 * filters. Those moved into the `(app)` route group, because the sign-in,
 * setup, invitation and password-reset pages must render for someone who has no
 * session at all: mounting the navigation and the dataset providers around a
 * login form would fire authenticated requests that are guaranteed to 401, and
 * would show the shape of the product to somebody not yet entitled to see it.
 *
 * Route groups do not affect URLs, so `/` and `/settings` are unchanged.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: `${BRAND.product} · ${BRAND.tagline}`,
    template: `%s · ${BRAND.product}`,
  },
  description: `${BRAND.company} Shorts intelligence: hit rate, outliers, tracked market share and competitive research across every channel you follow.`,
  // This is an internal tool behind a login; there is nothing to index and no
  // reason for a crawler to hold onto a URL from it.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `dark` is set here as the default and corrected before paint by
    // ThemeScript if the user has chosen light. suppressHydrationWarning is
    // required because that script mutates the class list before React hydrates.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-full">
        <ThemeProvider>
          <QueryProvider>
            <TooltipProvider delayDuration={200} skipDelayDuration={400}>
              {children}
              <Toaster
                position="bottom-right"
                toastOptions={{
                  // Match the design system rather than sonner's defaults.
                  classNames: {
                    toast:
                      "!bg-[var(--surface-raised)] !border-[var(--border)] !text-[var(--foreground)] !rounded-lg !text-[13px]",
                    description: "!text-[var(--muted-foreground)]",
                    actionButton: "!bg-[var(--accent)] !text-[var(--accent-foreground)]",
                  },
                }}
              />
            </TooltipProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
