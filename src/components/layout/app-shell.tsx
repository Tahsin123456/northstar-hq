"use client";

import * as React from "react";
import { Menu, X } from "lucide-react";
import { BrandMark, SidebarFooterNav, SidebarNav, ThemeToggle } from "./sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Application chrome.
 *
 * Desktop is the primary target — this is a comparison tool and comparison
 * needs width — so the sidebar is permanent from `lg` up. Below that it
 * collapses into a slide-over rather than stacking above the content, which
 * would push the data the user came for below the fold on every page.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Close the drawer on Escape — expected of anything modal-ish.
  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="flex min-h-dvh w-full">
      {/* --- Desktop sidebar ---

          PINNED TO THE VIEWPORT, not to the document.

          It used to be a plain column in a `min-h-dvh` row, so it grew to
          whatever the page was tall — and its footer went with it. On a long
          channel list that put Settings and the theme toggle thousands of
          pixels down, reachable only by scrolling past every row of content
          they have nothing to do with.

          `sticky top-0 h-dvh` fixes the height to the window and holds the
          column there while the main column scrolls underneath. Sticky rather
          than `fixed` because the aside stays in the flex row, so the main
          column's width is still computed from it — a fixed sidebar would be
          lifted out of flow and the content would slide under it. */}
      <aside className="sticky top-0 hidden h-dvh w-[212px] shrink-0 flex-col border-r border-border bg-surface-sunken lg:flex">
        <div className="flex h-14 shrink-0 items-center px-4">
          <BrandMark />
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-between px-3 pb-4">
          {/* The navigation scrolls INSIDE the sidebar if it ever outgrows the
              window — on a short laptop screen, or as sections are added. That
              keeps the overflow local: without `min-h-0` a flex child refuses to
              shrink below its content, and the footer would be pushed out of
              the sidebar rather than the list gaining a scrollbar. */}
          {/* Add Channel is no longer a button under the whole list. It was
              rendered here for every role, including the Long Form roles whose
              Channels row is not in their sidebar at all; it is now a row
              inside the Shorts section, gated on the permission the API checks
              — see the table in ./sidebar.tsx. */}
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
            <SidebarNav />
          </div>
          {/* The footer: the two controls that change the tool rather than the
              data. Settings sits above the theme toggle because it is the one
              with a page behind it.

              `shrink-0` is what makes "permanently visible" true rather than
              usually true — without it these two rows are the first thing a
              cramped column gives up. */}
          <div className="flex shrink-0 flex-col gap-0.5 pt-2">
            <SidebarFooterNav />
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* --- Mobile drawer --- */}
      <div
        className={cn(
          "fixed inset-0 z-40 lg:hidden",
          mobileOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!mobileOpen}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/55 backdrop-blur-[2px] transition-opacity duration-200",
            mobileOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setMobileOpen(false)}
        />
        <aside
          className={cn(
            "absolute inset-y-0 left-0 flex w-[248px] flex-col border-r border-border bg-surface-sunken",
            "transition-transform duration-200 ease-out",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <div className="flex h-14 items-center justify-between px-4">
            <BrandMark />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X />
            </Button>
          </div>
          {/* Same treatment as the desktop column. The drawer is already the
              height of the window — it is `inset-y-0` inside a fixed overlay —
              so Settings was never lost here, but a long nav on a short phone
              would have pushed it past the bottom edge with nothing to scroll.
              Identical classes on purpose: two sidebars that behave differently
              under pressure is how one of them quietly regresses. */}
          <div className="flex min-h-0 flex-1 flex-col justify-between px-3 pb-4">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
              {/* `onNavigate` closes the drawer on a link AND when the Add
                  Channel row opens its dialog — the same SidebarNav as the
                  desktop column, so the two cannot drift. */}
              <SidebarNav onNavigate={() => setMobileOpen(false)} />
            </div>
            <div className="flex shrink-0 flex-col gap-0.5 pt-2">
              <SidebarFooterNav onNavigate={() => setMobileOpen(false)} />
              <ThemeToggle />
            </div>
          </div>
        </aside>
      </div>

      {/* --- Main column --- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border px-4 lg:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>
          <BrandMark />
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

/**
 * Standard page frame: a title block, optional actions, and the body.
 * Every page uses it so headings, spacing and max-width stay identical.
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8", className)}>
      {children}
    </div>
  );
}
