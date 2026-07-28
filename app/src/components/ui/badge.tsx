import * as React from "react";
import { cn } from "../../lib/utils";

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  variant?: "default" | "secondary" | "outline" | "accent" | "success" | "warning";
}

function Badge({ className, variant = "default", ...props }: BadgeProps) {
  const variants = {
    default: "bg-blue-50 text-blue-700 border border-blue-200/70",
    secondary: "bg-slate-100 text-slate-700 border border-slate-200/80",
    outline: "bg-transparent text-slate-600 border border-slate-200",
    accent: "bg-indigo-50 text-indigo-700 border border-indigo-200/70",
    success: "bg-emerald-50 text-emerald-700 border border-emerald-200/70",
    warning: "bg-amber-50 text-amber-700 border border-amber-200/70",
  };

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none select-none",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}

export { Badge };
