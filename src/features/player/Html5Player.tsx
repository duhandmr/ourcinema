import { useEffect, useRef } from 'react';
import Hls from 'hls.js';
import { AutoplayBlockedError, type PlayerCallbacks, type PlayerController, type VideoSource } from './types';
import { useLatest } from './useLatest';

function mediaErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case 1:
      return 'Video yüklemesi durduruldu.';
    case 2:
      return 'Ağ hatası nedeniyle video yüklenemedi.';
    case 3:
      return 'Video çözümlenemedi. Dosya bozuk veya tarayıcı bu kodeki desteklemiyor olabilir.';
    case 4:
      return 'Video oynatılamıyor. Format desteklenmiyor ya da kaynak sunucu dışarıdan erişime izin vermiyor.';
    default:
      return 'Video oynatılamadı.';
  }
}

interface Props {
  source: VideoSource;
  callbacks: PlayerCallbacks;
}

/** MP4/WebM dosyaları ve HLS (m3u8) yayınları için yerel HTML5 oynatıcı. */
export function Html5Player({ source, callbacks }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cb = useLatest(callbacks);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let readyFired = false;
    let mediaRecoveryTried = false;

    const controller: PlayerController = {
      play: async () => {
        try {
          await video.play();
        } catch (err) {
          if (err instanceof DOMException && err.name === 'NotAllowedError') throw new AutoplayBlockedError();
          if (err instanceof DOMException && err.name === 'AbortError') return;
          throw err;
        }
      },
      pause: () => video.pause(),
      seek: (seconds) => {
        if (Number.isFinite(seconds)) video.currentTime = Math.max(0, seconds);
      },
      getCurrentTime: () => video.currentTime,
      isPaused: () => video.paused,
    };

    const onLoaded = () => {
      if (readyFired) return;
      readyFired = true;
      cb.current.onReady(controller);
    };
    const onPlay = () => cb.current.onPlay(video.currentTime);
    const onPause = () => {
      if (!video.ended) cb.current.onPause(video.currentTime);
    };
    const onSeeked = () => cb.current.onSeek(video.currentTime);
    const onError = () => cb.current.onError(mediaErrorMessage(video.error));

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);

    if (source.kind === 'hls') {
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || !hls) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryTried) {
            mediaRecoveryTried = true;
            hls.recoverMediaError();
            return;
          }
          cb.current.onError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? 'Yayın yüklenemedi. Bağlantı geçersiz olabilir ya da yayın sunucusu dışarıdan erişime (CORS) izin vermiyor.'
              : 'Yayın oynatılamadı.',
          );
          hls.destroy();
          hls = null;
        });
        hls.loadSource(source.url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source.url; // Safari / iOS yerel HLS
      } else {
        cb.current.onError('Bu tarayıcı HLS (m3u8) yayınlarını desteklemiyor.');
      }
    } else {
      video.src = source.url;
    }

    return () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [source.url, source.kind, cb]);

  return (
    <video
      ref={videoRef}
      className="h-full w-full bg-black object-contain"
      controls
      playsInline
      preload="metadata"
      controlsList="nodownload"
    />
  );
}
