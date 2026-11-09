import type { VideoSource } from './types';

/**
 * Kontrol API'si sunmayan resmi gömme oynatıcıları (Dailymotion, Twitch).
 * Bu kaynaklarda tam senkronizasyon yoktur; arayüz bunu açıkça belirtir.
 */
export function EmbedPlayer({ source }: { source: VideoSource }) {
  if (!source.embedUrl) return null;
  return (
    <iframe
      key={source.embedUrl}
      src={source.embedUrl}
      title={`${source.platformLabel} oynatıcısı`}
      className="h-full w-full border-0 bg-black"
      allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
      allowFullScreen
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}
