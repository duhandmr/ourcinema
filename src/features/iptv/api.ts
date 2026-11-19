/** Builds same-origin IPTV API URLs handled by the Vercel function. */
export function iptvApiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return normalizedPath;
}
