import type { ReactNode } from 'react';
import { Brand } from './Brand';

interface CenteredCardProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}

export function CenteredCard({ title, description, children }: CenteredCardProps) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-5 py-10">
      <div className="w-full max-w-md rounded-3xl border border-white/5 bg-ink-900/80 p-8 text-center shadow-cinema backdrop-blur">
        <Brand />
        <h1 className="mt-6 text-lg font-semibold text-mist-100">{title}</h1>
        {description && <div className="mt-2 text-sm leading-relaxed text-mist-300">{description}</div>}
        {children && <div className="mt-6 flex flex-col gap-3">{children}</div>}
      </div>
    </div>
  );
}
