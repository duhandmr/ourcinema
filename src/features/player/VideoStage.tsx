
import type { ReactNode } from 'react';
import { EmbedPlayer } from './EmbedPlayer';
import { Html5Player } from './Html5Player';
import type { DetectFailure, PlayerCallbacks, VideoSource } from './types';
import { VimeoPlayer } from './VimeoPlayer';
import { VlcWasmPlayer } from './VlcWasmPlayer';
import { YouTubePlayer } from './YouTubePlayer';

interface Props {
  source: VideoSource | null;
  /** Değiştiğinde oynatıcı yeniden kurulur */
  loadKey: number;
  failure: DetectFailure | null;
  playerError: string | null;
  needsGesture: boolean;
  callbacks: PlayerCallbacks;
  onGesture: () => void;
  onTryAsFile: (url: string) => void;
}

function ExternalLink({
  href,
  label = 'Kaynak sitesinde aç',
}: {
  href: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-mist-100 transition hover:bg-white/10"
    >
      {label} ↗
    </a>
  );
}

function Notice({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-ink-950 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-ink-800 text-2xl">
        {icon}
      </div>

      <p className="max-w-md text-sm leading-relaxed text-mist-300 sm:text-base">
        {title}
      </p>

      {children && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          {children}
        </div>
      )}
    </div>
  );
}

export function VideoStage({
  source,
  loadKey,
  failure,
  playerError,
  needsGesture,
  callbacks,
  onGesture,
  onTryAsFile,
}: Props) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/5 bg-black shadow-cinema sm:rounded-3xl">
      {source && (
        <div
          className="absolute inset-0"
          key={`${loadKey}:${source.kind}:${source.url}`}
        >
          {(source.kind === 'file' ||
            source.kind === 'hls' ||
            source.kind === 'mpegts') && (
            source.playerEngine === 'vlc-wasm' ? (
              <VlcWasmPlayer source={source} callbacks={callbacks} />
            ) : (
              <Html5Player source={source} callbacks={callbacks} />
            )
          )}

          {source.kind === 'youtube' && (
            <YouTubePlayer source={source} callbacks={callbacks} />
          )}

          {source.kind === 'vimeo' && (
            <VimeoPlayer source={source} callbacks={callbacks} />
          )}

          {(source.kind === 'dailymotion' ||
            source.kind === 'twitch') && <EmbedPlayer source={source} />}
        </div>
      )}

      {!source && !failure && (
        <Notice
          icon="🎬"
          title="Henüz bir video yok. Yukarıya bir bağlantı yapıştırın ve “Birlikte İzle”ye basın."
        />
      )}

      {!source && failure && (
        <Notice icon="🔒" title={failure.message}>
          {failure.url && <ExternalLink href={failure.url} />}

          {failure.reason === 'unknown' && failure.url && (
            <button
              type="button"
              onClick={() => onTryAsFile(failure.url as string)}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-mist-300 underline-offset-4 transition hover:text-mist-100 hover:underline"
            >
              Yine de video dosyası olarak dene
            </button>
          )}
        </Notice>
      )}

      {source && playerError && (
        <Notice icon="⚠️" title={playerError}>
          <ExternalLink href={source.url} />
        </Notice>
      )}

      {source && !playerError && needsGesture && (
        <button
          type="button"
          onClick={onGesture}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-mist-100 backdrop-blur-sm transition hover:bg-black/60"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent text-2xl shadow-lg shadow-accent/30">
            ▶
          </span>

          <span className="text-sm font-medium sm:text-base">
            Oynatmayı başlatmak için dokunun
          </span>

          <span className="max-w-xs text-xs text-mist-300">
            Tarayıcınız sesli videoların otomatik başlatılmasına izin vermiyor.
          </span>
        </button>
      )}
    </div>
  );
}
