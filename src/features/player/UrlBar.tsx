import { useState, type FormEvent } from 'react';

interface Props {
  disabled?: boolean;
  /** Kabul edilirse null, aksi halde kullanıcıya gösterilecek hata döner. */
  onSubmit: (url: string) => string | null;
}

export function UrlBar({ disabled, onSubmit }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = onSubmit(value);
    if (result) {
      setError(result);
    } else {
      setError(null);
      setValue('');
    }
  };

  return (
    <form onSubmit={submit} className="w-full" noValidate>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="İzlemek istediğiniz videonun bağlantısını yapıştırın..."
          aria-label="Video bağlantısı"
          aria-invalid={Boolean(error)}
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-ink-800 px-4 py-3 text-[16px] text-mist-100 outline-none transition placeholder:text-mist-500 focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-60 sm:text-sm"
        />
        <button
          type="submit"
          disabled={disabled || !value.trim()}
          className="shrink-0 rounded-xl bg-accent px-6 py-3 text-sm font-semibold tracking-wide text-white transition hover:bg-accent-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Birlikte İzle
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-accent-hover">
          {error}
        </p>
      )}
    </form>
  );
}
