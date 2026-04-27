import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#116466] focus-visible:ring-offset-2 focus-visible:ring-offset-[#cee1de] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:     'border border-[#116466]/40 bg-[#a6d0c4] text-[#0b4546] hover:bg-[#a9cec4]',
        destructive: 'border border-[#b54a43]/40 bg-[#ddb8b2] text-[#842a27] hover:bg-[#ddb5af]',
        outline:     'border border-[#9eb8b3] bg-transparent text-[#233c39] hover:bg-[#98b4af] hover:text-[#102221]',
        secondary:   'border border-[#9eb8b3] bg-[#cee1de] text-[#233c39] hover:bg-[#98b4af]',
        ghost:       'text-[#405551] hover:bg-[#cee1de] hover:text-[#102221]',
        success:     'border border-[#168a55]/45 bg-[#b0d6be] text-[#0f5634] hover:bg-[#b5d7c4]',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm:      'h-8 px-3 text-xs',
        icon:    'h-8 w-8',
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
    <button className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
  )
);

Button.displayName = 'Button';
