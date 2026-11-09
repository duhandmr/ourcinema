import { useEffect, useRef } from 'react';
import VimeoSdk from '@vimeo/player';
import { AutoplayBlockedError, type PlayerCallbacks, type PlayerController, type VideoSource } from './types';
import { useLatest } from './useLatest';

type VimeoOptions = ConstructorParameters<typeof VimeoSdk>[1];

function secondsOf(data: unknown): number {
  if (data && typeof data === 'object' && 'seconds' in data) {
    const s = (data as { seconds: unknown }).seconds;
    if (typeof s === 'number' && Number.isFinite(s)) return s;
  }
  return 0;
}

function errorName(data: unknown): string {
  if (data && typeof data === 'object' && 'name' in data) return String((data as { name: unknown }).name);
  return '';
}

interface Props {
  source: VideoSource;
  callbacks: PlayerCallbacks;
}

/** Resmi Vimeo Player SDK ile tam kontrol edilebilen oynatıcı. */
export function VimeoPlayer({ source, callbacks }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cb = useLatest(callbacks);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const mount = document.createElement('div');
    mount.className = 'h-full w-full';
    host.appendChild(mount);

    const options = { url: source.url, playsinline: true, responsive: false, dnt: true } as unknown as VimeoOptions;
    const player = new VimeoSdk(mount, options);

    let currentTime = 0;
    let paused = true;

    const controller: PlayerController = {
      play: async () => {
        try {
          await player.play();
        } catch (err) {
          if (errorName(err) === 'NotAllowedError') throw new AutoplayBlockedError();
          throw err;
        }
      },
      pause: () => {
        void player.pause().catch(() => undefined);
      },
      seek: (seconds) => {
        currentTime = Math.max(0, seconds);
        void player.setCurrentTime(currentTime).catch(() => undefined);
      },
      getCurrentTime: () => currentTime,
      isPaused: () => paused,
    };

    player.on('timeupdate', (data: unknown) => {
      currentTime = secondsOf(data);
    });
    player.on('play', (data: unknown) => {
      paused = false;
      currentTime = secondsOf(data);
      cb.current.onPlay(currentTime);
    });
    player.on('pause', (data: unknown) => {
      paused = true;
      currentTime = secondsOf(data);
      cb.current.onPause(currentTime);
    });
    player.on('ended', () => {
      paused = true;
    });
    player.on('seeked', (data: unknown) => {
      currentTime = secondsOf(data);
      cb.current.onSeek(currentTime);
    });
    player.on('error', (data: unknown) => {
      if (errorName(data) === 'NotAllowedError') return;
      if (!disposed) cb.current.onError('Vimeo videosu oynatılamadı.');
    });

    player
      .ready()
      .then(() => {
        if (!disposed) cb.current.onReady(controller);
      })
      .catch(() => {
        if (!disposed) {
          cb.current.onError('Vimeo videosu yüklenemedi. Video gizli olabilir ya da sahibi gömülmesine izin vermiyor olabilir.');
        }
      });

    return () => {
      disposed = true;
      void player.destroy().catch(() => undefined);
      host.replaceChildren();
    };
  }, [source.url, cb]);

  return <div ref={hostRef} className="oc-embed h-full w-full bg-black" />;
}
