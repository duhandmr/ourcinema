/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Optional public origin of a separately hosted IPTV API. */
  readonly VITE_IPTV_PLAYBACK_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
