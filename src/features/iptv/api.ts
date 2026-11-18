/** Builds IPTV API URLs for local proxying or a separately hosted API. */
export function iptvApiUrl(path: string): string {
  const base = import.meta.env.VITE_IPTV_API_URL?.trim().replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return `${base ?? ''}${normalizedPath}`;
}
