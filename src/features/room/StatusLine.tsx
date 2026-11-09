export type StatusTone = 'info' | 'success' | 'warn' | 'error';

export interface StatusMessage {
  tone: StatusTone;
  text: string;
}

const DOT: Record<StatusTone, string> = {
  info: 'bg-mist-300',
  success: 'bg-online',
  warn: 'bg-gold',
  error: 'bg-accent',
};

export function StatusLine({ status, activity }: { status: StatusMessage; activity: string | null }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-white/5 bg-ink-900/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="flex items-start gap-2.5 text-sm text-mist-100" role="status" aria-live="polite">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[status.tone]} ${status.tone === 'success' ? 'animate-pulse' : ''}`} />
        {status.text}
      </p>
      {activity && <p className="pl-[18px] text-xs text-mist-500 sm:pl-0 sm:text-right">{activity}</p>}
    </div>
  );
}
