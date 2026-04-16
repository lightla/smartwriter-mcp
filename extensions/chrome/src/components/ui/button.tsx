import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-100 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border border-amber-700/50 bg-amber-900/40 text-amber-500 hover:bg-amber-900/60',
        destructive: 'border border-rose-700/50 bg-rose-900/40 text-rose-500 hover:bg-rose-900/60',
        outline: 'border border-stone-500/40 bg-stone-800 text-stone-300 hover:bg-stone-700/50',
        secondary: 'border border-amber-700/50 bg-amber-950/30 text-amber-500/80 hover:bg-amber-900/40',
        ghost: 'text-stone-500 hover:bg-stone-800 hover:text-stone-400',
        success: 'border border-amber-500/70 bg-amber-800/40 text-amber-300 hover:bg-amber-700/50',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  )
);

Button.displayName = 'Button';
