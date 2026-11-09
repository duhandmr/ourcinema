import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { configProblem, env } from './env';
import { rememberStorage } from './rememberStorage';

let client: SupabaseClient | null = null;

/** Tek Supabase istemcisi. Yalnızca anon/publishable anahtar kullanılır. */
export function getSupabase(): SupabaseClient {
  if (configProblem) {
    throw new Error('Supabase yapılandırması eksik veya hatalı.');
  }
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: rememberStorage,
        storageKey: 'ourcinema.auth',
      },
      realtime: {
        params: { eventsPerSecond: 20 },
      },
    });
  }
  return client;
}
