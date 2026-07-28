import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?:
    | "default"
    | "orange"
    | "primary"
    | "secondary"
    | "outline"
    | "destructive"
    | "ghost"
    | "accent"
    | "dark";
  size?: "default" | "sm" | "lg" | "icon";
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "default",
      size = "default",
      asChild = false,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";

    const baseStyles =
      "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 cursor-pointer select-none active:scale-[0.98]";

    const variants = {
      default:
        "bg-blue-600 hover:bg-blue-500 text-white shadow-xs",
      primary:
        "bg-blue-600 hover:bg-blue-500 text-white shadow-xs",
      orange:
        "bg-amber-600 hover:bg-amber-500 text-white shadow-xs",
      secondary:
        "bg-white hover:bg-slate-50 text-slate-700 border border-slate-200/90 shadow-2xs",
      outline:
        "bg-transparent hover:bg-slate-100/80 text-slate-700 border border-slate-200/90",
      destructive:
        "bg-rose-600 hover:bg-rose-500 text-white shadow-xs",
      ghost:
        "bg-transparent hover:bg-slate-100 text-slate-600 hover:text-slate-900",
      accent:
        "bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs",
      dark:
        "bg-slate-900 hover:bg-slate-800 text-white shadow-xs",
    };

    const sizes = {
      default: "h-9 px-4 py-2 text-sm",
      sm: "h-8 px-3 text-xs",
      lg: "h-10 px-5 text-sm font-semibold",
      icon: "h-9 w-9 p-0 flex items-center justify-center rounded-lg",
    };

    return (
      <Comp
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };
