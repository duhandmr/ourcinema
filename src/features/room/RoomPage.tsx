import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { CenteredCard } from '../../components/CenteredCard';
import { FullScreenLoader } from '../../components/Spinner';
import { getSupabase } from '../../lib/supabase';
import { formatTime } from '../../utils/format';
import { useAuth } from '../auth/AuthProvider';
import { detectSource } from '../player/detectSource';
import type { DetectFailure, PlayerCallbacks, SourceKind, VideoSource } from '../player/types';
import { UrlBar } from '../player/UrlBar';
import { VideoStage } from '../player/VideoStage';
import { RoomChannel, type ChannelStatus } from '../realtime/RoomChannel';
import { fetchRoomState, fetchServerTime, saveRoomState } from '../sync/roomStateRepo';
import { ServerClock } from '../sync/serverClock';
import { SyncEngine, type ActivityKind } from '../sync/SyncEngine';
import type { PersistPayload } from '../sync/types';
import { PresenceBar } from './PresenceBar';
import { StatusLine, type StatusMessage } from './StatusLine';
import { TopBar } from './TopBar';
import { useRoom, type RoomData } from './useRoom';

export function RoomPage({ user }: { user: User }) {
  const { signOut } = useAuth();
  const { state, reload } = useRoom(user.id);

  if (state.status === 'loading') return <FullScreenLoader label="Sinema salonu hazırlanıyor…" />;

  if (state.status === 'forbidden') {
    return (
      <CenteredCard
        title="Bu özel odaya erişiminiz yok"
        description="Hesabınız OurCinema odasına eklenmemiş. Yönetici sizi odaya eklemelidir."
      >
        <button type="button" onClick={() => void signOut()} className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-hover">
          Çıkış yap
        </button>
      </CenteredCard>
    );
  }

  if (state.status === 'error') {
    return (
      <CenteredCard title="Oda açılamadı" description={state.message}>
        <button type="button" onClick={reload} className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-hover">
          Tekrar dene
        </button>
        <button type="button" onClick={() => void signOut()} className="rounded-xl px-4 py-3 text-sm text-mist-300 hover:text-mist-100">
          Çıkış yap
        </button>
      </CenteredCard>
    );
  }

  return <Room data={state.data} user={user} onSignOut={() => void signOut()} />;
}

function describeActivity(kind: ActivityKind, isSelf: boolean, name: string, position: number): string {
  const t = formatTime(position);
  switch (kind) {
    case 'play':
      return isSelf ? `Videoyu başlattın · ${t}` : `${name} videoyu başlattı · ${t}`;
    case 'pause':
      return isSelf ? `Videoyu durdurdun · ${t}` : `${name} videoyu durdurdu · ${t}`;
    case 'seek':
      return isSelf ? `Videoyu ${t} konumuna aldın` : `${name} videoyu ${t} konumuna aldı`;
    case 'load':
      return isSelf ? 'Yeni bir video açtın' : `${name} yeni bir video açtı`;
  }
}

interface RoomProps {
  data: RoomData;
  user: User;
  onSignOut: () => void;
}

function Room({ data, user, onSignOut }: RoomProps) {
  const [source, setSource] = useState<VideoSource | null>(null);
  const [failure, setFailure] = useState<DetectFailure | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [channelStatus, setChannelStatus] = useState<ChannelStatus>('connecting');
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const [activity, setActivity] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  /** Aynı bağlantı yeniden açıldığında oynatıcıyı yeniden kurmak için */
  const [loadNonce, setLoadNonce] = useState(0);
  const engineRef = useRef<SyncEngine | null>(null);

  const partner = data.members.find((m) => m.userId !== user.id) ?? null;

  const nameOf = useCallback(
    (id: string) => data.members.find((m) => m.userId === id)?.displayName ?? 'Partnerin',
    [data.members],
  );

  const showActivity = useCallback(
    (kind: ActivityKind, by: string, position: number) => {
      setActivity(`${describeActivity(kind, by === user.id, nameOf(by), position)} · ${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`);
    },
    [nameOf, user.id],
  );

  /** Bağlantıyı yerel oynatıcıya uygular (yayın yapmaz). */
  const applyUrl = useCallback((url: string, sourceType: SourceKind | null) => {
    const result = detectSource(url, { forceFile: sourceType === 'file' });
    setPlayerError(null);
    setNeedsGesture(false);
    setLoadNonce((n) => n + 1);
    if (result.ok) {
      setSource(result.source);
      setFailure(null);
    } else {
      setSource(null);
      setFailure(result);
    }
  }, []);

  // ---------------------------------------------------------------- bağlantı + senkronizasyon
  useEffect(() => {
    const supabase = getSupabase();
    const channel = new RoomChannel(supabase, data.roomId, user.id);
    const clock = new ServerClock();
    let disposed = false;
    let persistTimer: number | undefined;
    let pendingSave: PersistPayload | null = null;
    let wasDisconnected = false;

    const flushSave = () => {
      const toSave = pendingSave;
      pendingSave = null;
      if (!toSave) return;
      saveRoomState(supabase, data.roomId, toSave)
        .then(() => !disposed && setSaveFailed(false))
        .catch(() => !disposed && setSaveFailed(true));
    };

    const engine = new SyncEngine(user.id, channel, clock, {
      onRemoteLoad: (url, sourceType) => {
        if (!disposed) applyUrl(url, sourceType);
      },
      onActivity: (kind, by, position) => {
        if (!disposed) showActivity(kind, by, position);
      },
      onNeedsGesture: (needed) => {
        if (!disposed) setNeedsGesture(needed);
      },
      persist: (payload) => {
        pendingSave = payload;
        window.clearTimeout(persistTimer);
        persistTimer = window.setTimeout(flushSave, 250);
      },
    });
    engineRef.current = engine;
    engine.start();

    const offPresence = channel.onPresence((ids) => !disposed && setOnlineIds(ids));
    const offStatus = channel.onStatus((status) => {
      if (disposed) return;
      setChannelStatus(status);
      if (status === 'reconnecting' || status === 'error') wasDisconnected = true;
      if (status === 'connected') {
        if (wasDisconnected) {
          wasDisconnected = false;
          fetchRoomState(supabase, data.roomId)
            .then((row) => {
              if (!disposed && row) engine.hydrate(row, 1.5);
            })
            .catch(() => undefined);
        }
        engine.requestState();
      }
    });

    (async () => {
      await clock.calibrate(() => fetchServerTime(supabase));
      if (disposed) return;
      if (data.initialState) engine.hydrate(data.initialState);
      await channel.connect();
    })().catch(() => {
      if (!disposed) setChannelStatus('error');
    });

    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') engine.requestState();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(persistTimer);
      flushSave();
      offPresence();
      offStatus();
      engine.stop();
      channel.disconnect();
      engineRef.current = null;
    };
    // Not: data.initialState yalnızca ilk açılışta kullanılır.
  }, [data.roomId, user.id, applyUrl, showActivity]);

  // Kontrol API'si olmayan kaynaklarda senkronizasyon devre dışı
  useEffect(() => {
    if (source && !source.syncCapable) engineRef.current?.attach(null, false);
  }, [source]);

  // ---------------------------------------------------------------- oynatıcı olayları
  const callbacks = useMemo<PlayerCallbacks>(
    () => ({
      onReady: (controller) => {
        setPlayerError(null);
        engineRef.current?.attach(controller, true);
      },
      onPlay: (t) => {
        if (engineRef.current?.localPlay(t)) showActivity('play', user.id, t);
      },
      onPause: (t) => {
        if (engineRef.current?.localPause(t)) showActivity('pause', user.id, t);
      },
      onSeek: (t) => {
        if (engineRef.current?.localSeek(t)) showActivity('seek', user.id, t);
      },
      onError: (message) => {
        setPlayerError(message);
        setNeedsGesture(false);
      },
    }),
    [showActivity, user.id],
  );

  const startSource = useCallback(
    (next: VideoSource) => {
      setLoadNonce((n) => n + 1);
      setSource(next);
      setFailure(null);
      setPlayerError(null);
      setNeedsGesture(false);
      engineRef.current?.loadVideo(next.url, next.kind);
      showActivity('load', user.id, 0);
    },
    [showActivity, user.id],
  );

  const handleSubmit = useCallback(
    (raw: string): string | null => {
      const result = detectSource(raw);
      if (result.ok) {
        startSource(result.source);
        return null;
      }
      if (result.reason === 'empty' || result.reason === 'invalid' || result.reason === 'insecure') {
        return result.message;
      }
      // Desteklenmeyen platform / bilinmeyen sayfa: yalnızca yerelde açıklama gösterilir, yayınlanmaz.
      engineRef.current?.detach();
      setSource(null);
      setPlayerError(null);
      setNeedsGesture(false);
      setFailure(result);
      return null;
    },
    [startSource],
  );

  const handleTryAsFile = useCallback(
    (url: string) => {
      const result = detectSource(url, { forceFile: true });
      if (result.ok) startSource(result.source);
    },
    [startSource],
  );

  const handleGesture = useCallback(() => {
    void engineRef.current?.resumeFromGesture();
  }, []);

  // ---------------------------------------------------------------- durum mesajı
  const partnerOnline = partner ? onlineIds.includes(partner.userId) : false;
  const status = useMemo<StatusMessage>(() => {
    if (isOffline) return { tone: 'error', text: 'İnternet bağlantısı yok. Bağlantı geri geldiğinde senkronizasyon kaldığı yerden devam edecek.' };
    if (channelStatus === 'error') return { tone: 'error', text: 'Gerçek zamanlı bağlantı kurulamadı. Yeniden deneniyor; sorun sürerse sayfayı yenileyin.' };
    if (channelStatus === 'reconnecting') return { tone: 'warn', text: 'Bağlantı koptu, yeniden bağlanılıyor…' };
    if (channelStatus === 'connecting') return { tone: 'info', text: 'Odaya bağlanılıyor…' };
    if (playerError) return { tone: 'error', text: 'Video oynatılamıyor. Başka bir bağlantı deneyin.' };
    if (failure) return { tone: 'warn', text: 'Bu bağlantı burada oynatılamıyor; yalnızca sizin ekranınızda gösteriliyor.' };
    if (source && !source.syncCapable) {
      return { tone: 'warn', text: `${source.platformLabel} oynatıcısı dışarıdan kontrol edilemiyor: video ikinize de açıldı ama oynatma/durdurma senkronize edilmez. Birlikte manuel başlatın.` };
    }
    if (saveFailed) return { tone: 'warn', text: 'Oda durumu kaydedilemedi; canlı senkronizasyon devam ediyor.' };
    if (!partnerOnline) {
      return { tone: 'info', text: `${partner?.displayName ?? 'Partnerin'} henüz çevrimiçi değil. Katıldığında video otomatik olarak eşitlenecek.` };
    }
    if (!source) return { tone: 'success', text: 'İkiniz de buradasınız. Bir bağlantı ekleyip izlemeye başlayın.' };
    return { tone: 'success', text: `Senkronize · ${source.platformLabel}` };
  }, [isOffline, channelStatus, playerError, failure, source, saveFailed, partnerOnline, partner]);

  return (
    <div className="min-h-[100dvh]">
      <TopBar members={data.members} onlineIds={onlineIds} onSignOut={onSignOut} />

      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 pb-10 pt-5 sm:gap-5 sm:px-6 sm:pt-6" style={{ paddingBottom: 'max(2.5rem, env(safe-area-inset-bottom))' }}>
        <PresenceBar members={data.members} onlineIds={onlineIds} currentUserId={user.id} />
        <UrlBar onSubmit={handleSubmit} />
        <VideoStage
          source={source}
          loadKey={loadNonce}
          failure={failure}
          playerError={playerError}
          needsGesture={needsGesture}
          callbacks={callbacks}
          onGesture={handleGesture}
          onTryAsFile={handleTryAsFile}
        />
        <StatusLine status={status} activity={activity} />
        <p className="text-center text-xs leading-relaxed text-mist-500">
          Tam senkronizasyon: MP4/WebM, HLS (m3u8), YouTube, Vimeo · Yalnızca gömme: Dailymotion, Twitch
        </p>
      </main>
    </div>
  );
}
