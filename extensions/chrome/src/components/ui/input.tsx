import * as React from 'react';

import { cn } from '../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      className={cn(
        'flex h-9 w-full rounded-md border border-[#9eb8b3] bg-[#e2ecea] px-3 py-2 text-sm text-[#102221] shadow-sm transition-colors placeholder:text-[#4f625e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#116466] focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      ref={ref}
      type={type}
      {...props}
    />
  )
);

Input.displayName = 'Input';
