import { useState, type FormEvent } from 'react';
import { Brand } from '../../components/Brand';
import { Spinner } from '../../components/Spinner';
import { getRememberPreference } from '../../lib/rememberStorage';
import { useAuth } from './AuthProvider';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(getRememberPreference());
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (!email.trim() || !password) {
      setError('E-posta ve şifre gerekli.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email, password, remember);
      // Başarılı girişte AuthProvider oturumu günceller ve oda otomatik açılır.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Giriş yapılamadı.');
      setSubmitting(false);
    }
  };

  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(224,49,59,0.12),transparent_55%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-[radial-gradient(ellipse_at_bottom,rgba(217,181,108,0.06),transparent_60%)]" />

      <section className="relative w-full max-w-sm rounded-3xl border border-white/5 bg-ink-900/80 p-8 shadow-cinema backdrop-blur-xl sm:p-10">
        <header className="text-center">
          <Brand size="lg" />
          <p className="mt-3 text-sm font-light italic tracking-wide text-mist-300">Your private cinema.</p>
        </header>

        <form className="mt-10 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.18em] text-mist-500">E-posta</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              className="rounded-xl border border-white/10 bg-ink-800 px-4 py-3 text-[16px] text-mist-100 outline-none transition placeholder:text-mist-500 focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
              placeholder="ornek@eposta.com"
            />
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.18em] text-mist-500">Şifre</span>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="w-full rounded-xl border border-white/10 bg-ink-800 px-4 py-3 pr-20 text-[16px] text-mist-100 outline-none transition placeholder:text-mist-500 focus:border-accent/60 focus:ring-2 focus:ring-accent/20 disabled:opacity-60"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-2 my-auto h-8 rounded-lg px-3 text-xs font-medium text-mist-300 transition hover:bg-white/5 hover:text-mist-100"
                aria-label={showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
              >
                {showPassword ? 'Gizle' : 'Göster'}
              </button>
            </div>
          </label>

          <label className="mt-1 flex cursor-pointer items-center gap-3 text-sm text-mist-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={submitting}
              className="h-4 w-4 rounded border-white/20 bg-ink-800 accent-[#E0313B]"
            />
            Beni hatırla
          </label>

          {error && (
            <p role="alert" className="rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-sm text-mist-100">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3.5 text-sm font-semibold tracking-wide text-white transition hover:bg-accent-hover active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting && <Spinner className="h-4 w-4" />}
            {submitting ? 'Giriş yapılıyor…' : 'Giriş yap'}
          </button>
        </form>

        <p className="mt-8 text-center text-xs text-mist-500">Yalnızca davetli iki kullanıcı içindir.</p>
      </section>
    </main>
  );
}
