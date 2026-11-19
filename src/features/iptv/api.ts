/** Builds IPTV API URLs for Vercel or an independently hosted API server. */
export function iptvApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const apiOrigin = import.meta.env.VITE_IPTV_API_URL?.trim().replace(/\/+$/, '');

  return apiOrigin ? `${apiOrigin}${normalizedPath}` : normalizedPath;
}
