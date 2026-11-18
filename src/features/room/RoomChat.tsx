import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RoomChatMessage } from '../realtime/RoomChannel';
import type { RoomMember } from './useRoom';

interface Props {
  members: RoomMember[];
  currentUserId: string;
  messages: RoomChatMessage[];
  connected: boolean;
  historyError: boolean;
  onSend(text: string): Promise<void>;
}

function timeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

export function RoomChat({ members, currentUserId, messages, connected, historyError, onSend }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const names = new Map(members.map((member) => [member.userId, member.displayName]));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !connected || sending) return;
    setSending(true);
    setSendError('');
    try {
      await onSend(text);
      setDraft('');
    } catch {
      setSendError('Mesaj kaydedilemedi. Bağlantıyı kontrol edip tekrar dene.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="flex h-full min-h-[34rem] flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-900/80 shadow-xl shadow-black/10 lg:min-h-0" aria-label="Oda sohbeti">
      <header className="flex items-center justify-between border-b border-white/8 px-4 py-2.5 sm:px-5">
        <div>
          <h2 className="text-[13px] font-semibold text-mist-100">Oda sohbeti</h2>
          <p className="mt-0.5 text-[11px] text-mist-500">Birlikte izlerken mesajlaşın</p>
        </div>
        <span className={`flex items-center gap-2 rounded-full px-2.5 py-1 text-[10px] font-medium ${connected ? 'bg-online/10 text-online' : 'bg-amber-400/10 text-amber-200'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-online' : 'bg-amber-300'}`} />
          {connected ? 'Canlı' : 'Bağlanıyor'}
        </span>
      </header>

      {historyError && (
        <p role="status" className="border-b border-amber-300/10 bg-amber-300/[0.04] px-4 py-2 text-[11px] text-amber-100/80 sm:px-5">
          Sohbet geçmişi için Supabase güncellemesi gerekiyor.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3 sm:px-5" aria-live="polite" aria-relevant="additions">
        {messages.length === 0 ? (
          <div className="m-auto max-w-xs text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5 text-lg text-mist-300" aria-hidden="true">✦</div>
            <p className="text-[13px] font-medium text-mist-200">Sohbeti başlatın</p>
            <p className="mt-1 text-[11px] leading-relaxed text-mist-500">İlk mesajı gönder; odadaki herkes anında görsün.</p>
          </div>
        ) : messages.map((message) => {
          const own = message.userId === currentUserId;
          return (
            <article key={message.id} className={`flex max-w-[88%] flex-col ${own ? 'ml-auto items-end' : 'mr-auto items-start'}`}>
              <div className="mb-1 flex items-center gap-2 px-1 text-[10px] text-mist-500">
                <span className="font-medium text-mist-300">{own ? 'Sen' : names.get(message.userId) ?? 'Kullanıcı'}</span>
                <time dateTime={new Date(message.sentAt).toISOString()}>{timeLabel(message.sentAt)}</time>
              </div>
              <p className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed ${own ? 'rounded-br-md bg-accent text-white' : 'rounded-bl-md border border-white/8 bg-ink-800 text-mist-100'}`}>
                {message.text}
              </p>
            </article>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={submit} className="flex items-end gap-2 border-t border-white/8 bg-ink-950/40 p-3 sm:p-4">
        <label className="sr-only" htmlFor="room-chat-message">Mesajınız</label>
        <textarea
          id="room-chat-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, 1000))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={connected ? 'Bir mesaj yaz…' : 'Bağlantı kuruluyor…'}
          rows={1}
          maxLength={1000}
          disabled={!connected || sending}
          className="max-h-28 min-h-10 flex-1 resize-y rounded-xl border border-white/10 bg-ink-800 px-3.5 py-2.5 text-[13px] text-mist-100 outline-none transition placeholder:text-mist-500 focus:border-accent/60 focus:ring-2 focus:ring-accent/15 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!connected || sending || !draft.trim()}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl bg-accent px-3.5 text-xs font-semibold text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span>{sending ? 'Kaydediliyor' : 'Gönder'}</span>
          {!sending && <span aria-hidden="true">↑</span>}
        </button>
      </form>
      {sendError && <p role="alert" className="px-4 pb-2 text-[11px] text-red-300 sm:px-5">{sendError}</p>}
      <p className="px-4 pb-2.5 text-[9px] text-mist-600 sm:px-5">Enter ile gönder · Shift + Enter ile yeni satır</p>
    </section>
  );
}
