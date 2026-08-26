"use client";

import * as React from "react";
import { cn, initialsFrom } from "@/lib/utils";

/**
 * Channel avatar with a deterministic fallback.
 *
 * YouTube avatar URLs expire and occasionally 404, so the fallback is not an
 * edge case — it renders regularly. Initials on a tinted ground keep a table of
 * channels visually parseable even when several images fail at once.
 *
 * Deliberately a plain <img>, not next/image: these are remote, small,
 * above-the-fold in a dense table, and the optimiser's benefit is outweighed
 * by needing every YouTube CDN host allow-listed.
 */
export function Avatar({
  src,
  name,
  size = 32,
  className,
  rounded = "full",
}: {
  src: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
  rounded?: "full" | "md";
}) {
  // Which source failed, rather than a boolean "has failed".
  //
  // Recording the URL means a new `src` (after a refresh, say) is automatically
  // considered untried again — the reset falls out of the comparison during
  // render instead of needing an effect that sets state on every prop change.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showImage = Boolean(src) && failedSrc !== src;

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-surface-hover",
        rounded === "full" ? "rounded-full" : "rounded-md",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src ?? undefined}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src ?? null)}
          className="size-full object-cover"
        />
      ) : (
        <span
          className="font-medium text-subtle-foreground select-none"
          style={{ fontSize: Math.max(9, Math.round(size * 0.36)) }}
        >
          {initialsFrom(name)}
        </span>
      )}
    </span>
  );
}
