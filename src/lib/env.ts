const rawUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const rawKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

/** service_role / secret anahtarı yanlışlıkla istemciye konursa uygulama çalışmayı reddeder. */
function looksLikeSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: string };
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

function isAllowedUrl(url: string): boolean {
  return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url);
}

export type ConfigProblem = 'missing' | 'secret-key' | 'bad-url' | null;

export const configProblem: ConfigProblem = !rawUrl || !rawKey
  ? 'missing'
  : looksLikeSecretKey(rawKey)
    ? 'secret-key'
    : !isAllowedUrl(rawUrl)
      ? 'bad-url'
      : null;

export const env = {
  supabaseUrl: rawUrl,
  supabaseAnonKey: rawKey,
} as const;
