
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import { iptvFetch } from '../iptv/api';
import {
  AutoplayBlockedError,
  type PlayerCallbacks,
  type PlayerController,
  type VideoSource,
} from './types';
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

function subtitleTimeToSeconds(value: string): number | null {
  const time = value.trim().match(/^(?:(\d{2}):)?(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!time) return null;

  const hours = Number(time[1] || 0);
  const minutes = Number(time[2]);
  const seconds = Number(time[3]);
  const milliseconds = Number(time[4]);
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function parseSubtitleCues(
  content: string,
): Array<{ start: number; end: number; text: string }> {
  return content
    .replace(/^\uFEFF?WEBVTT[^\n]*\n/i, '')
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .flatMap((block) => {
      const lines = block.split('\n');
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) return [];

      const [rawStart, rawEnd] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
      const start = subtitleTimeToSeconds(rawStart);
      const end = subtitleTimeToSeconds(rawEnd);
      const text = lines.slice(timingIndex + 1).join('\n').trim();

      return start !== null && end !== null && end > start && text
        ? [{ start, end, text }]
        : [];
    });
}

interface Props {
  source: VideoSource;
  callbacks: PlayerCallbacks;
}

interface NativeAudioTrackList {
  length: number;
  [index: number]: {
    label: string;
    language: string;
    enabled: boolean;
  };
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/** MP4/WebM, HLS ve MPEG-TS yayınları için HTML5 oynatıcı. */
export function Html5Player({ source, callbacks }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const subtitleAutoSelectedRef = useRef(false);
  const nativeAudioTrackListRef = useRef<NativeAudioTrackList | null>(null);
  const externalSubtitleTrackRef = useRef<TextTrack | null>(null);
  const subtitleRequestRef = useRef(0);
  const cb = useLatest(callbacks);
  const [audioTracks, setAudioTracks] = useState<
    Array<{ id: number; name: string; lang?: string }>
  >([]);
  const [subtitleTracks, setSubtitleTracks] = useState<
    Array<{ id: number; name: string; lang?: string }>
  >([]);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState(-1);
  const [selectedSubtitleTrack, setSelectedSubtitleTrack] = useState(-1);
  const [nativeAudioTracks, setNativeAudioTracks] = useState<
    Array<{ id: number; name: string; lang: string }>
  >([]);
  const [nativeSubtitleTracks, setNativeSubtitleTracks] = useState<
    Array<{ id: number; name: string; lang: string }>
  >([]);
  const [selectedSidecarTrack, setSelectedSidecarTrack] = useState(-1);
  const [subtitleError, setSubtitleError] = useState<string | null>(null);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls: Hls | null = null;
    let mpegtsPlayer: ReturnType<typeof mpegts.createPlayer> | null = null;
    let readyFired = false;
    let mediaRecoveryTried = false;
    const nativeAudioTrackList = (
      video as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }
    ).audioTracks;
    nativeAudioTrackListRef.current = nativeAudioTrackList ?? null;

    const refreshNativeTracks = () => {
      const tracks = Array.from(video.textTracks);
      setNativeSubtitleTracks(
        tracks.map((track, id) => ({
          id,
          name: track.label,
          lang: track.language,
        })),
      );

      if (!subtitleAutoSelectedRef.current) {
        const turkishTrackId = tracks.findIndex((track) =>
          /^(tr|tur|turkish)|turkish|türkçe/i.test(
            `${track.language} ${track.label}`,
          ),
        );
        if (turkishTrackId >= 0) {
          tracks.forEach((track, id) => {
            track.mode = id === turkishTrackId ? 'showing' : 'disabled';
          });
          setSelectedSubtitleTrack(turkishTrackId);
          subtitleAutoSelectedRef.current = true;
        }
      }

      if (nativeAudioTrackList) {
        setNativeAudioTracks(
          Array.from({ length: nativeAudioTrackList.length }, (_, id) => ({
            id,
            name: nativeAudioTrackList[id].label,
            lang: nativeAudioTrackList[id].language,
          })),
        );
      }
    };

    const controller: PlayerController = {
      play: async () => {
        try {
          await video.play();
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === 'NotAllowedError'
          ) {
            throw new AutoplayBlockedError();
          }

          if (err instanceof DOMException && err.name === 'AbortError') {
            return;
          }

          throw err;
        }
      },
      pause: () => video.pause(),
      seek: (seconds) => {
        if (Number.isFinite(seconds)) {
          video.currentTime = Math.max(0, seconds);
        }
      },
      getCurrentTime: () => video.currentTime,
      isPaused: () => video.paused,
    };

    const onLoaded = () => {
      refreshNativeTracks();
      if (readyFired) return;

      readyFired = true;
      cb.current.onReady(controller);
    };

    const onPlay = () => cb.current.onPlay(video.currentTime);

    const onPause = () => {
      if (!video.ended) {
        cb.current.onPause(video.currentTime);
      }
    };

    const onSeeked = () => cb.current.onSeek(video.currentTime);

    const onError = () => {
      cb.current.onError(mediaErrorMessage(video.error));
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.textTracks.addEventListener('addtrack', refreshNativeTracks);
    nativeAudioTrackList?.addEventListener?.('addtrack', refreshNativeTracks);
    setAudioTracks([]);
    setSubtitleTracks([]);
    setSelectedAudioTrack(-1);
    setSelectedSubtitleTrack(-1);
    setNativeAudioTracks([]);
    setNativeSubtitleTracks([]);
    setSelectedSidecarTrack(-1);
    setTrackMenuOpen(false);
    subtitleAutoSelectedRef.current = false;

    if (source.kind === 'mpegts') {
      if (!mpegts.isSupported()) {
        cb.current.onError(
          'Bu tarayıcı MPEG-TS yayınlarını desteklemiyor.',
        );
      } else {
        mpegtsPlayer = mpegts.createPlayer({
          type: 'mpegts',
          isLive: source.isLive ?? true,
          url: source.url,
        });

        mpegtsPlayer.on(mpegts.Events.ERROR, () => {
          cb.current.onError(
            'MPEG-TS yayını yüklenemedi. Yayın adresini, CORS izinlerini ve sunucu erişimini kontrol edin.',
          );
        });

        mpegtsPlayer.attachMediaElement(video);
        mpegtsPlayer.load();
      }
    } else if (source.kind === 'hls') {
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;

        const refreshTracks = () => {
          const tracks = hls?.subtitleTracks ?? [];
          setAudioTracks(
            hls?.audioTracks.map(({ id, name, lang }) => ({
              id,
              name,
              lang,
            })) ?? [],
          );
          setSubtitleTracks(
            tracks.map(({ id, name, lang }) => ({
              id,
              name,
              lang,
            })) ?? [],
          );

          if (hls && !subtitleAutoSelectedRef.current) {
            const turkishTrack = tracks.find((track) =>
              /^(tr|tur|turkish)|turkish|türkçe/i.test(
                `${track.lang} ${track.name}`,
              ),
            );
            if (turkishTrack) {
              hls.subtitleTrack = turkishTrack.id;
              setSelectedSubtitleTrack(turkishTrack.id);
              subtitleAutoSelectedRef.current = true;
            }
          }
        };

        hls.on(Hls.Events.MANIFEST_PARSED, refreshTracks);
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshTracks);
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshTracks);
        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
          setSelectedAudioTrack(data.id);
        });
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_event, data) => {
          setSelectedSubtitleTrack(data.id);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || !hls) return;

          if (
            data.type === Hls.ErrorTypes.MEDIA_ERROR &&
            !mediaRecoveryTried
          ) {
            mediaRecoveryTried = true;
            hls.recoverMediaError();
            return;
          }

          cb.current.onError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? 'Yayın yüklenemedi. Bağlantı geçersiz olabilir ya da yayın sunucusu CORS izni vermiyor olabilir.'
              : 'Yayın oynatılamadı.',
          );

          hls.destroy();
          hls = null;
        });

        hls.loadSource(source.url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source.url;
      } else {
        cb.current.onError(
          'Bu tarayıcı HLS (m3u8) yayınlarını desteklemiyor.',
        );
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
      video.textTracks.removeEventListener('addtrack', refreshNativeTracks);
      nativeAudioTrackList?.removeEventListener?.(
        'addtrack',
        refreshNativeTracks,
      );

      hls?.destroy();
      hlsRef.current = null;
      nativeAudioTrackListRef.current = null;

      if (mpegtsPlayer) {
        mpegtsPlayer.pause();
        mpegtsPlayer.unload();
        mpegtsPlayer.detachMediaElement();
        mpegtsPlayer.destroy();
        mpegtsPlayer = null;
      }

      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [source.url, source.kind, source.isLive, cb]);

  useEffect(() => {
    const video = videoRef.current;
    if (
      !subtitleAutoSelectedRef.current &&
      selectedSidecarTrack < 0 &&
      source.subtitleTracks?.length
    ) {
      const turkishIndex = source.subtitleTracks.findIndex((track) =>
        /^(tr|tur|turkish)|turkish|türkçe/i.test(
          `${track.language} ${track.label}`,
        ),
      );
      if (turkishIndex >= 0) {
        setSelectedSidecarTrack(turkishIndex);
        subtitleAutoSelectedRef.current = true;
        return;
      }
    }
    const selectedTrack = source.subtitleTracks?.[selectedSidecarTrack];
    const requestId = ++subtitleRequestRef.current;
    setSubtitleError(null);
    if (!video) return;

    const disableExternalTrack = () => {
      if (externalSubtitleTrackRef.current) {
        externalSubtitleTrackRef.current.mode = 'disabled';
      }
    };

    if (!selectedTrack) {
      disableExternalTrack();
      return () => {
        subtitleRequestRef.current += 1;
      };
    }

    const loadSidecar = async () => {
      try {
        const response = await iptvFetch(
          `/api/iptv/subtitle?url=${encodeURIComponent(selectedTrack.url)}`,
        );
        if (!response.ok) {
          throw new Error('Altyazı dosyası sunucudan alınamadı.');
        }

        const cues = parseSubtitleCues(await response.text());
        if (cues.length === 0) {
          throw new Error('Altyazı dosyası okunamadı veya boş.');
        }
        if (requestId !== subtitleRequestRef.current) return;

        for (const track of Array.from(video.textTracks)) {
          track.mode = 'disabled';
        }
        if (hlsRef.current) hlsRef.current.subtitleTrack = -1;

        const textTrack =
          externalSubtitleTrackRef.current ||
          video.addTextTrack(
            'subtitles',
            selectedTrack.label,
            selectedTrack.language,
          );
        if (textTrack.cues) {
          for (const cue of Array.from(textTrack.cues)) {
            textTrack.removeCue(cue);
          }
        }
        for (const cue of cues) {
          textTrack.addCue(new VTTCue(cue.start, cue.end, cue.text));
        }

        externalSubtitleTrackRef.current = textTrack;
        textTrack.mode = 'showing';
      } catch (error) {
        if (requestId === subtitleRequestRef.current) {
          setSubtitleError(
            error instanceof Error ? error.message : 'Altyazı yüklenemedi.',
          );
        }
      }
    };

    void loadSidecar();
    return () => {
      subtitleRequestRef.current += 1;
      disableExternalTrack();
    };
  }, [source.url, source.subtitleTracks, selectedSidecarTrack]);

  return (
    <>
      <video
        ref={videoRef}
        className="h-full w-full bg-black object-contain"
        controls
        playsInline
        preload="metadata"
        controlsList="nodownload"
      />
      <button
        type="button"
        aria-label="Altyazı ve ses seçeneklerini aç"
        aria-expanded={trackMenuOpen}
        onClick={() => setTrackMenuOpen((open) => !open)}
        className="absolute right-3 top-3 z-30 flex items-center gap-2 rounded-xl border border-accent/50 bg-[#171014]/95 px-3.5 py-2.5 text-xs font-semibold text-white shadow-[0_8px_28px_rgba(224,49,59,0.28)] backdrop-blur-md transition hover:border-accent hover:bg-[#25151a]"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-accent/20 text-[10px] font-black text-accent">
          CC
        </span>
        <span>Altyazı / Ses</span>
      </button>
      {trackMenuOpen && (
        <div className="absolute right-3 top-14 z-20 flex max-w-[calc(100%-1.5rem)] flex-col gap-2 rounded-xl border border-white/10 bg-black/85 p-3 shadow-lg backdrop-blur-md">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-white/45">
            Yayının sunduğu diller
          </p>
          {subtitleError && (
            <p role="alert" className="max-w-64 text-xs text-red-300">
              {subtitleError}
            </p>
          )}
          {(audioTracks.length > 1 || nativeAudioTracks.length > 1) && (
            <label className="flex items-center gap-1.5 text-[11px] text-white/65">
              <span>Ses</span>
              {audioTracks.length > 1 ? (
                <select
                  aria-label="Ses dili"
                  value={selectedAudioTrack}
                  onChange={(event) => {
                    const trackId = Number(event.target.value);
                    setSelectedAudioTrack(trackId);
                    if (hlsRef.current) hlsRef.current.audioTrack = trackId;
                  }}
                  className="max-w-32 rounded-lg border border-white/10 bg-[#15151b] px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60"
                >
                  <option value={-1}>Otomatik</option>
                  {audioTracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.lang ? `${track.lang.toUpperCase()} · ` : ''}
                      {track.name || `Ses ${track.id + 1}`}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  aria-label="Ses dili"
                  value={
                    selectedAudioTrack >= 0
                      ? selectedAudioTrack
                      : nativeAudioTracks[0]?.id ?? 0
                  }
                  onChange={(event) => {
                    const trackId = Number(event.target.value);
                    if (nativeAudioTrackListRef.current) {
                      Array.from(
                        { length: nativeAudioTrackListRef.current.length },
                        (_, id) => {
                          const track = nativeAudioTrackListRef.current?.[id];
                          if (track) track.enabled = id === trackId;
                        },
                      );
                    }
                    setSelectedAudioTrack(trackId);
                  }}
                  className="max-w-32 rounded-lg border border-white/10 bg-[#15151b] px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60"
                >
                  {nativeAudioTracks.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.lang ? `${track.lang.toUpperCase()} · ` : ''}
                      {track.name || `Ses ${track.id + 1}`}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}
          {(subtitleTracks.length > 0 ||
            nativeSubtitleTracks.length > 0 ||
            Boolean(source.subtitleTracks?.length)) && (
            <label className="flex items-center gap-1.5 text-[11px] text-white/65">
              <span>Altyazı</span>
              <select
                aria-label="Altyazı dili"
                value={
                  selectedSidecarTrack >= 0
                    ? `sidecar:${selectedSidecarTrack}`
                    : subtitleTracks.length > 0
                      ? `hls:${selectedSubtitleTrack}`
                      : nativeSubtitleTracks.length > 0
                        ? `native:${selectedSubtitleTrack}`
                        : 'off'
                }
                onChange={(event) => {
                  const [kind, rawId] = event.target.value.split(':');
                  if (kind === 'sidecar') {
                    const trackId = Number(rawId);
                    setSelectedSubtitleTrack(-1);
                    if (hlsRef.current) hlsRef.current.subtitleTrack = -1;
                    setSelectedSidecarTrack(trackId);
                    return;
                  }

                  setSelectedSidecarTrack(-1);
                  if (kind === 'hls') {
                    const trackId = Number(rawId);
                    setSelectedSubtitleTrack(trackId);
                    if (hlsRef.current) hlsRef.current.subtitleTrack = trackId;
                  } else if (kind === 'native') {
                    const trackId = Number(rawId);
                    Array.from(videoRef.current?.textTracks ?? []).forEach(
                      (track, id) => {
                        track.mode = id === trackId ? 'showing' : 'disabled';
                      },
                    );
                    setSelectedSubtitleTrack(trackId);
                  } else {
                    setSelectedSubtitleTrack(-1);
                    if (hlsRef.current) hlsRef.current.subtitleTrack = -1;
                    Array.from(videoRef.current?.textTracks ?? []).forEach(
                      (track) => {
                        track.mode = 'disabled';
                      },
                    );
                  }
                }}
                className="max-w-40 rounded-lg border border-white/10 bg-[#15151b] px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60"
              >
                <option value="off">Kapalı</option>
                {subtitleTracks.map((track) => (
                  <option key={`hls-${track.id}`} value={`hls:${track.id}`}>
                    {track.lang ? `${track.lang.toUpperCase()} · ` : ''}
                    {track.name || `Altyazı ${track.id + 1}`}
                  </option>
                ))}
                {nativeSubtitleTracks.map((track) => (
                  <option key={`native-${track.id}`} value={`native:${track.id}`}>
                    {track.lang ? `${track.lang.toUpperCase()} · ` : ''}
                    {track.name || `Altyazı ${track.id + 1}`}
                  </option>
                ))}
                {source.subtitleTracks?.map((track, id) => (
                  <option key={`sidecar-${track.url}`} value={`sidecar:${id}`}>
                    {track.language ? `${track.language.toUpperCase()} · ` : ''}
                    {track.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {audioTracks.length <= 1 &&
            nativeAudioTracks.length <= 1 &&
            subtitleTracks.length === 0 &&
            nativeSubtitleTracks.length === 0 &&
            !source.subtitleTracks?.length && (
            <p className="max-w-64 text-xs leading-relaxed text-white/55">
              Bu akış oynatıcıya seçilebilir ses veya altyazı parçası bildirmedi.
              İçerik sağlayıcısında parça bulunsa bile yayın akışına eklenmemiş olabilir.
            </p>
          )}
        </div>
      )}
    </>
  );
}
