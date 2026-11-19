import { getSupabase } from '../../lib/supabase';

/** Builds IPTV API URLs for Vercel or an independently hosted API server. */
export function iptvApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const configuredOrigin = import.meta.env.VITE_IPTV_API_URL?.trim().replace(/\/+$/, '');
  // Temporary Quick Tunnel for the authorized live trial; set VITE_IPTV_API_URL
  // when replacing it with a named, stable Cloudflare Tunnel.
  const apiOrigin = configuredOrigin || (import.meta.env.PROD
    ? 'https://rfc-plasma-introducing-institutes.trycloudflare.com'
    : '');

  return apiOrigin ? `${apiOrigin}${normalizedPath}` : normalizedPath;
}

/** Sends the current Supabase session with every IPTV API request. */
export async function iptvFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { data, error } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (error || !token) throw new Error('IPTV için oturum açmanız gerekiyor.');

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);

  return fetch(iptvApiUrl(path), { ...init, headers });
}

/** Adds the session token to media URLs, which native video engines cannot authenticate with headers. */
export async function authorizeIptvPlaybackUrl(url: string): Promise<string> {
  const playbackUrl = new URL(url, window.location.href);
  const upstreamUrl = playbackUrl.searchParams.get('url') || url;
  const response = await iptvFetch('/api/iptv/playback-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: upstreamUrl }),
  });
  const data = (await response.json()) as { token?: string; error?: string };
  if (!response.ok || !data.token) {
    throw new Error(data.error || `Oynatma izni alınamadı. HTTP ${response.status}`);
  }

  playbackUrl.searchParams.set('playback_token', data.token);
  return playbackUrl.toString();
}
