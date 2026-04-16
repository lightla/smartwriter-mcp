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
        outline: 'border border-stone-700 bg-stone-800 text-stone-400 hover:bg-stone-700',
        secondary: 'bg-stone-800 text-stone-400 hover:bg-stone-700',
        ghost: 'text-stone-500 hover:bg-stone-800 hover:text-stone-400',
        success: 'border border-teal-600 bg-teal-800 text-teal-100 hover:bg-teal-700',
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
