import { useEffect, useRef, useState } from 'react';
import type { Player, Track } from 'libvlc-wasm';
import { AutoplayBlockedError, type PlayerCallbacks, type PlayerController, type VideoSource } from './types';
import { useLatest } from './useLatest';

interface Props {
  source: VideoSource;
  callbacks: PlayerCallbacks;
}

let vlcPromise: Promise<import('libvlc-wasm').VLC> | null = null;

function getVlc(): Promise<import('libvlc-wasm').VLC> {
  if (!vlcPromise) {
    vlcPromise = import('libvlc-wasm').then(({ createVLC }) =>
      createVLC({ threads: 4, decoderThreads: 2, logLevel: 'error' }),
    );
  }
  return vlcPromise;
}

function isLanguage(track: Track, language: 'turkish' | 'english'): boolean {
  const value = `${track.language ?? ''} ${track.name ?? ''} ${track.description ?? ''}`.toLowerCase();
  return language === 'turkish'
    ? /\b(tr|tur|turkish|türkçe)\b/.test(value)
    : /\b(en|eng|english)\b/.test(value);
}

function trackLabel(track: Track, index: number): string {
  const language = track.language?.toUpperCase();
  return `${language ? `${language} · ` : ''}${track.name || track.codecName || `Parça ${index + 1}`}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = Math.floor(seconds % 60).toString().padStart(2, '0');
  return hours
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${remaining}`
    : `${minutes}:${remaining}`;
}

function safeVlcMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, '[stream URL]');
}

export function VlcWasmPlayer({ source, callbacks }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const audioAutoSelectedRef = useRef(false);
  const subtitleAutoSelectedRef = useRef(false);
  const cb = useLatest(callbacks);
  const [player, setPlayer] = useState<Player | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [audioTrackId, setAudioTrackId] = useState('');
  const [subtitleTrackId, setSubtitleTrackId] = useState('off');
  const [menuOpen, setMenuOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [needsGesture, setNeedsGesture] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let mediaPlayer: Player | null = null;
    const unsubscribe: Array<() => void> = [];
    let lastVlcError = '';

    const open = async () => {
      try {
        audioAutoSelectedRef.current = false;
        subtitleAutoSelectedRef.current = false;
        setLoading(true);
        setError('');
        if (!window.crossOriginIsolated) {
          throw new Error('Bu tarayıcı oturumu VLC motoru için gereken güvenli medya başlıkları olmadan açıldı. Sayfayı yeniden yükleyin.');
        }

        const vlc = await getVlc();
        if (cancelled || !hostRef.current) return;
        unsubscribe.push(vlc.on('log', ({ level, message }) => {
          if (level === 'error' || level === 'warn') {
            lastVlcError = safeVlcMessage(message);
          }
        }));

        const canvas = document.createElement('canvas');
        canvas.className = 'h-full w-full bg-black';
        hostRef.current.prepend(canvas);
        mediaPlayer = await vlc.createPlayer({ canvas, fit: 'contain', keepAwake: false });
        if (cancelled) {
          await mediaPlayer.destroy();
          return;
        }

        playerRef.current = mediaPlayer;
        setPlayer(mediaPlayer);
        const controller: PlayerController = {
          play: async () => {
            try {
              await mediaPlayer?.play();
            } catch (playError) {
              if (playError instanceof DOMException && playError.name === 'NotAllowedError') {
                throw new AutoplayBlockedError();
              }
              throw playError;
            }
          },
          pause: () => { void mediaPlayer?.pause(); },
          seek: (seconds) => { if (Number.isFinite(seconds)) void mediaPlayer?.seek(Math.max(0, seconds)); },
          getCurrentTime: () => mediaPlayer?.currentTime ?? 0,
          isPaused: () => mediaPlayer?.paused ?? true,
        };

        let lastReportedTime = 0;
        let readySent = false;
        unsubscribe.push(
          mediaPlayer.on('tracks', (nextTracks) => {
            setTracks(nextTracks);
            const audioTracks = nextTracks.filter((track) => track.type === 'audio');
            const subtitleTracks = nextTracks.filter((track) => track.type === 'text');
            const english = audioTracks.find((track) => isLanguage(track, 'english'));
            const turkish = subtitleTracks.find((track) => isLanguage(track, 'turkish'));
            const activeAudio = audioTracks.find((track) => track.selected);
            const activeSubtitle = subtitleTracks.find((track) => track.selected);

            if (!audioAutoSelectedRef.current && audioTracks.length > 0) {
              if (english) {
                setAudioTrackId(english.id);
                void mediaPlayer?.selectTrack(english).catch(() => {});
              } else if (activeAudio) {
                setAudioTrackId(activeAudio.id);
              } else if (audioTracks[0]) {
                setAudioTrackId(audioTracks[0].id);
              }
              audioAutoSelectedRef.current = true;
            }

            if (!subtitleAutoSelectedRef.current && subtitleTracks.length > 0) {
              if (turkish) {
                setSubtitleTrackId(turkish.id);
                void mediaPlayer?.selectTrack(turkish).catch(() => {});
              } else if (activeSubtitle) {
                setSubtitleTrackId(activeSubtitle.id);
              }
              subtitleAutoSelectedRef.current = true;
            }

            if (!readySent) {
              readySent = true;
              cb.current.onReady(controller);
            }
          }),
          mediaPlayer.on('playing', () => {
            setPaused(false);
            setNeedsGesture(false);
            cb.current.onPlay(mediaPlayer?.currentTime ?? 0);
          }),
          mediaPlayer.on('paused', () => {
            setPaused(true);
            cb.current.onPause(mediaPlayer?.currentTime ?? 0);
          }),
          mediaPlayer.on('durationchange', (seconds) => setDuration(seconds)),
          mediaPlayer.on('volumechange', ({ volume: nextVolume, muted }) => {
            setVolume(muted ? 0 : nextVolume);
          }),
          mediaPlayer.on('timeupdate', (seconds) => {
            setCurrentTime(seconds);
            if (lastReportedTime > 0 && Math.abs(seconds - lastReportedTime) > 2) {
              cb.current.onSeek(seconds);
            }
            lastReportedTime = seconds;
          }),
          mediaPlayer.on('error', (mediaError) => {
            const message = [mediaError.message || 'Video açılamadı.', lastVlcError]
              .filter(Boolean)
              .join(' · ');
            setError(message);
            cb.current.onError(message);
          }),
        );

        // VLC's URL access module requires an absolute HTTP URL. The app's
        // same-origin proxy is intentionally represented as `/api/...` for
        // HTML media players, but VLC interprets that relative path as a local
        // file (`file:///url/...`) unless it is resolved against the page.
        const mediaUrl = new URL(source.url, window.location.href).toString();
        await mediaPlayer.open(mediaUrl, { autoplay: false });
        if (cancelled) return;
        setLoading(false);
        setDuration(mediaPlayer.duration || 0);
        setTracks(mediaPlayer.tracks);
        if (!readySent) {
          readySent = true;
          cb.current.onReady(controller);
        }

        // IPTV selection can finish after an API request and the WASM engine
        // startup, so the original click may no longer count as a browser
        // gesture. Try autoplay and leave an obvious play action if blocked.
        if (source.autoPlay !== false) {
          try {
            await mediaPlayer.play();
            if (mediaPlayer.audioContext?.state === 'suspended') {
              await mediaPlayer.pause();
              setNeedsGesture(true);
            }
          } catch (playError) {
            if (playError instanceof DOMException && playError.name === 'NotAllowedError') {
              setNeedsGesture(true);
              return;
            }
            throw playError;
          }
        }
      } catch (openError) {
        if (cancelled) return;
        if (openError instanceof DOMException && openError.name === 'NotAllowedError') {
          setLoading(false);
          setNeedsGesture(true);
          return;
        }
        const message = [
          openError instanceof Error ? openError.message : 'VLC player başlatılamadı.',
          lastVlcError,
        ].filter(Boolean).join(' · ');
        setError(message);
        setLoading(false);
        cb.current.onError(message);
      }
    };

    void open();
    return () => {
      cancelled = true;
      unsubscribe.forEach((off) => off());
      playerRef.current = null;
      if (mediaPlayer) void mediaPlayer.destroy();
    };
  }, [source.url, cb]);

  const audioTracks = tracks.filter((track) => track.type === 'audio');
  const subtitleTracks = tracks.filter((track) => track.type === 'text');

  async function chooseAudio(trackId: string) {
    setAudioTrackId(trackId);
    const track = audioTracks.find((item) => item.id === trackId);
    if (track) await playerRef.current?.selectTrack(track);
  }

  async function chooseSubtitle(trackId: string) {
    setSubtitleTrackId(trackId);
    if (trackId === 'off') {
      await playerRef.current?.disableTrack('text');
      return;
    }
    const track = subtitleTracks.find((item) => item.id === trackId);
    if (track) await playerRef.current?.selectTrack(track);
  }

  async function startPlayback() {
    try {
      await player?.play();
      setNeedsGesture(false);
    } catch (playError) {
      if (playError instanceof DOMException && playError.name === 'NotAllowedError') {
        setNeedsGesture(true);
        return;
      }
      const message = playError instanceof Error ? playError.message : 'Video başlatılamadı.';
      setError(message);
      cb.current.onError(message);
    }
  }

  return (
    <div ref={hostRef} className="group absolute inset-0 overflow-hidden bg-black text-white">
      {loading && !error && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-black/75 text-sm text-white/75">
          VLC player yükleniyor…
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-0 z-20 grid place-items-center bg-black/90 p-6 text-center text-sm text-red-200">
          {error}
        </div>
      )}

      {player && !error && (
        <>
          {paused && !loading && (
            <div className="pointer-events-none absolute inset-0 z-[5] grid place-items-center">
              <button
                type="button"
                aria-label="Videoyu başlat"
                onClick={() => void startPlayback()}
                className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full bg-accent text-2xl text-white shadow-lg shadow-accent/40 transition hover:scale-105 hover:bg-accent/90"
              >
                ▶
              </button>
              {needsGesture && (
                <span className="absolute mt-24 rounded-lg bg-black/75 px-3 py-2 text-xs text-white/90">
                  Oynatmayı başlatmak için dokunun
                </span>
              )}
            </div>
          )}
          <div className="absolute inset-x-0 top-0 z-10 flex justify-end bg-gradient-to-b from-black/60 to-transparent p-3">
            <button
              type="button"
              aria-label="Altyazı ve ses seçeneklerini aç"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              className="flex items-center gap-2 rounded-xl border border-accent/50 bg-[#171014]/95 px-3.5 py-2.5 text-xs font-semibold shadow-[0_8px_28px_rgba(224,49,59,0.28)] transition hover:border-accent hover:bg-[#25151a]"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-accent/20 text-[10px] font-black text-accent">CC</span>
              <span>Altyazı / Ses</span>
            </button>
          </div>

          {menuOpen && (
            <div className="absolute right-3 top-14 z-20 flex max-w-[calc(100%-1.5rem)] flex-col gap-2 rounded-xl border border-white/10 bg-black/90 p-3 shadow-lg backdrop-blur-md">
              {audioTracks.length > 0 && (
                <label className="flex items-center justify-between gap-3 text-xs text-white/75">
                  <span>Ses</span>
                  <select aria-label="Ses dili" value={audioTrackId} onChange={(event) => void chooseAudio(event.target.value)} className="max-w-44 rounded-lg border border-white/10 bg-[#15151b] px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60">
                    {audioTracks.map((track, index) => <option key={track.id} value={track.id}>{trackLabel(track, index)}</option>)}
                  </select>
                </label>
              )}
              {subtitleTracks.length > 0 && (
                <label className="flex items-center justify-between gap-3 text-xs text-white/75">
                  <span>Altyazı</span>
                  <select aria-label="Altyazı dili" value={subtitleTrackId} onChange={(event) => void chooseSubtitle(event.target.value)} className="max-w-44 rounded-lg border border-white/10 bg-[#15151b] px-2 py-1.5 text-xs text-white outline-none focus:border-accent/60">
                    <option value="off">Kapalı</option>
                    {subtitleTracks.map((track, index) => <option key={track.id} value={track.id}>{trackLabel(track, index)}</option>)}
                  </select>
                </label>
              )}
              {audioTracks.length === 0 && subtitleTracks.length === 0 && (
                <p className="max-w-64 text-xs leading-relaxed text-white/55">Bu dosyada seçilebilir ses veya altyazı parçası bulunamadı.</p>
              )}
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-3 pb-3 pt-8 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button type="button" aria-label={paused ? 'Oynat' : 'Duraklat'} onClick={() => void (paused ? startPlayback() : player.pause())} className="rounded-md px-2 py-1 text-lg hover:bg-white/10">
              {paused ? '▶' : '❚❚'}
            </button>
            <input aria-label="Video konumu" type="range" min={0} max={duration || 1} step={1} value={Math.min(currentTime, duration || 1)} onChange={(event) => { const time = Number(event.target.value); void player.seek(time); cb.current.onSeek(time); }} className="min-w-0 flex-1 accent-accent" />
            <span className="whitespace-nowrap text-xs tabular-nums text-white/75">{formatTime(currentTime)} / {formatTime(duration)}</span>
            <button type="button" aria-label={volume > 0 ? 'Sesi kapat' : 'Sesi aç'} onClick={() => { if (player.muted || volume === 0) { player.muted = false; player.volume = 1; setVolume(1); } else { player.muted = true; setVolume(0); } }} className="rounded-md px-1 py-1 text-sm hover:bg-white/10">{volume > 0 ? '🔊' : '🔇'}</button>
            <input aria-label="Ses seviyesi" type="range" min={0} max={1} step={0.05} value={volume} onChange={(event) => { const nextVolume = Number(event.target.value); player.volume = nextVolume; player.muted = nextVolume === 0; setVolume(nextVolume); }} className="hidden w-16 accent-accent sm:block" />
            <button type="button" aria-label="Tam ekran" onClick={() => { const root = hostRef.current; if (!root) return; if (document.fullscreenElement) void document.exitFullscreen(); else void root.requestFullscreen?.(); }} className="rounded-md px-2 py-1 text-lg hover:bg-white/10">⛶</button>
          </div>
        </>
      )}
    </div>
  );
}
