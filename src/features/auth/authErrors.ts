import type { AuthError } from '@supabase/supabase-js';

export function mapAuthError(error: AuthError | Error): string {
  const message = (error.message || '').toLowerCase();
  const status = 'status' in error ? (error as AuthError).status : undefined;

  if (message.includes('invalid login credentials')) return 'E-posta veya şifre hatalı.';
  if (message.includes('email not confirmed')) return 'E-posta adresi henüz doğrulanmamış.';
  if (status === 429 || message.includes('rate limit') || message.includes('too many')) {
    return 'Çok fazla deneme yapıldı. Lütfen biraz bekleyip tekrar deneyin.';
  }
  if (error.name === 'AuthRetryableFetchError' || message.includes('failed to fetch') || message.includes('network')) {
    return 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.';
  }
  return 'Giriş yapılamadı. Lütfen tekrar deneyin.';
}
