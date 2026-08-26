"use client";

import * as React from "react";
import { Menu, X } from "lucide-react";
import { BrandMark, SidebarNav, ThemeToggle } from "./sidebar";
import { Button } from "@/components/ui/button";
import { AddChannelDialog } from "@/components/channels/add-channel-dialog";
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
      {/* --- Desktop sidebar --- */}
      <aside className="hidden w-[212px] shrink-0 flex-col border-r border-border bg-surface-sunken lg:flex">
        <div className="flex h-14 items-center px-4">
          <BrandMark />
        </div>
        <div className="flex flex-1 flex-col justify-between px-3 pb-4">
          <div className="flex flex-col gap-4">
            <SidebarNav />
            <div className="px-1">
              <AddChannelDialog
                trigger={
                  <Button variant="secondary" size="sm" className="w-full justify-start">
                    <span className="text-base leading-none">+</span>
                    Add Channel
                  </Button>
                }
              />
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
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
          <div className="flex flex-1 flex-col justify-between px-3 pb-4">
            <div className="flex flex-col gap-4">
              <SidebarNav onNavigate={() => setMobileOpen(false)} />
              <div className="px-1">
                <AddChannelDialog
                  onOpenChange={(open) => open && setMobileOpen(false)}
                  trigger={
                    <Button variant="secondary" size="sm" className="w-full justify-start">
                      <span className="text-base leading-none">+</span>
                      Add Channel
                    </Button>
                  }
                />
              </div>
            </div>
            <ThemeToggle />
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
