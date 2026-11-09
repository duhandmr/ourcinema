import { useEffect, useRef } from 'react';
import { loadYouTubeApi } from './loadYouTubeApi';
import { AutoplayBlockedError, type PlayerCallbacks, type PlayerController, type VideoSource } from './types';
import { useLatest } from './useLatest';

const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const UNSTARTED = -1;

function youTubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'YouTube bağlantısı geçersiz.';
    case 5:
      return 'Bu YouTube videosu tarayıcıda oynatılamıyor.';
    case 100:
      return 'Video bulunamadı, kaldırılmış veya gizli.';
    case 101:
    case 150:
    case 153:
      return 'Video sahibi bu videonun başka sitelerde oynatılmasına izin vermiyor. Videoyu YouTube’da açabilirsiniz.';
    default:
      return 'YouTube videosu oynatılamadı.';
  }
}

interface Props {
  source: VideoSource;
  callbacks: PlayerCallbacks;
}

/** Resmi YouTube IFrame Player API ile tam kontrol edilebilen oynatıcı. */
export function YouTubePlayer({ source, callbacks }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const cb = useLatest(callbacks);

  useEffect(() => {
    const host = hostRef.current;
    const videoId = source.videoId;
    if (!host || !videoId) return;

    let disposed = false;
    let player: YT.Player | null = null;
    let poll: number | undefined;
    const mount = document.createElement('div');
    host.appendChild(mount);

    // YouTube'da "seek" olayı yok: zaman sıçramalarını izleyerek tespit ediyoruz.
    let lastTime = 0;
    let lastWall = performance.now();
    let lastState = UNSTARTED;

    const controller: PlayerController = {
      play: () =>
        new Promise<void>((resolve, reject) => {
          if (!player) return resolve();
          player.playVideo();
          const startedAt = performance.now();
          const check = () => {
            if (disposed || !player) return resolve();
            const state = player.getPlayerState();
            if (state === PLAYING) return resolve();
            if (performance.now() - startedAt > 2500) {
              return state === BUFFERING ? resolve() : reject(new AutoplayBlockedError());
            }
            window.setTimeout(check, 150);
          };
          window.setTimeout(check, 150);
        }),
      pause: () => player?.pauseVideo(),
      seek: (seconds) => {
        const target = Math.max(0, seconds);
        player?.seekTo(target, true);
        lastTime = target;
        lastWall = performance.now();
      },
      getCurrentTime: () => player?.getCurrentTime() ?? 0,
      isPaused: () => {
        const state = player?.getPlayerState();
        return state !== PLAYING && state !== BUFFERING;
      },
    };

    loadYouTubeApi()
      .then((api) => {
        if (disposed) return;
        player = new api.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1, enablejsapi: 1, origin: window.location.origin },
          events: {
            onReady: () => {
              if (disposed || !player) return;
              cb.current.onReady(controller);
              lastTime = player.getCurrentTime();
              lastWall = performance.now();
              poll = window.setInterval(() => {
                if (!player) return;
                const now = performance.now();
                const t = player.getCurrentTime();
                const state = player.getPlayerState();
                const expected = lastState === PLAYING ? lastTime + (now - lastWall) / 1000 : lastTime;
                if (lastState !== UNSTARTED && Math.abs(t - expected) > 1.5) cb.current.onSeek(t);
                lastTime = t;
                lastWall = now;
                lastState = state;
              }, 500);
            },
            onStateChange: (event) => {
              const t = event.target.getCurrentTime();
              if (event.data === PLAYING) cb.current.onPlay(t);
              else if (event.data === PAUSED) cb.current.onPause(t);
            },
            onError: (event) => cb.current.onError(youTubeErrorMessage(event.data)),
          },
        });
      })
      .catch((err: unknown) => {
        if (!disposed) cb.current.onError(err instanceof Error ? err.message : 'YouTube oynatıcısı yüklenemedi.');
      });

    return () => {
      disposed = true;
      if (poll) window.clearInterval(poll);
      try {
        player?.destroy();
      } catch {
        // oynatıcı zaten kaldırılmış olabilir
      }
      player = null;
      host.replaceChildren();
    };
  }, [source.videoId, cb]);

  return <div ref={hostRef} className="oc-embed h-full w-full bg-black" />;
}
