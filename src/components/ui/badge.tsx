import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Small status chip.
 *
 * `hit` is the one that matters: it marks a Short that cleared the threshold.
 * It uses a tinted background plus coloured text rather than a solid fill, so a
 * table with thirty hits in it stays readable instead of turning into a wall of
 * green.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded font-medium whitespace-nowrap border",
  {
    variants: {
      variant: {
        neutral: "bg-surface-raised text-muted-foreground border-border",
        hit: "bg-success-subtle text-success border-transparent",
        near: "bg-warning-subtle text-warning border-transparent",
        miss: "bg-transparent text-subtle-foreground border-transparent",
        accent: "bg-accent-subtle text-accent border-transparent",
        danger: "bg-danger-subtle text-danger border-transparent",
        outline: "bg-transparent text-muted-foreground border-border",
      },
      size: {
        sm: "px-1.5 py-0.5 text-[10px] tracking-wide uppercase",
        md: "px-2 py-0.5 text-[11px]",
        lg: "px-2.5 py-1 text-xs",
      },
    },
    defaultVariants: { variant: "neutral", size: "md" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
