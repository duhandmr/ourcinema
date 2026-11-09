interface SpinnerProps {
  className?: string;
}

export function Spinner({ className = 'h-5 w-5' }: SpinnerProps) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function FullScreenLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 text-mist-300">
      <Spinner className="h-7 w-7 text-accent" />
      <p className="text-sm tracking-wide">{label}</p>
    </div>
  );
}
