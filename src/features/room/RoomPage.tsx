
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { CenteredCard } from '../../components/CenteredCard';
import { FullScreenLoader } from '../../components/Spinner';
import { getSupabase } from '../../lib/supabase';
import { formatTime } from '../../utils/format';
import { useAuth } from '../auth/AuthProvider';
import { detectSource } from '../player/detectSource';
import type {
  DetectFailure,
  PlayerCallbacks,
  SourceKind,
  SubtitleTrackSource,
  VideoSource,
} from '../player/types';
import { UrlBar } from '../player/UrlBar';
import { VideoStage } from '../player/VideoStage';
import { IptvPanel } from '../iptv/IptvPanel';
import { authorizeIptvPlaybackUrl, iptvFetch } from '../iptv/api';
import type { IptvChannel } from '../iptv/m3u';
import { RoomChannel, type ChannelStatus, type RoomChatMessage } from '../realtime/RoomChannel';
import {
  fetchRoomState,
  fetchServerTime,
  saveRoomState,
} from '../sync/roomStateRepo';
import { ServerClock } from '../sync/serverClock';
import { SyncEngine, type ActivityKind } from '../sync/SyncEngine';
import type { PersistPayload } from '../sync/types';
import { PresenceBar } from './PresenceBar';
import { RoomChat } from './RoomChat';
import { fetchRecentRoomChat, saveRoomChatMessage } from './roomChatRepo';
import { StatusLine, type StatusMessage } from './StatusLine';
import { TopBar } from './TopBar';
import { useRoom, type RoomData } from './useRoom';

function isSupportedIptvSource(source: VideoSource): boolean {
  return (
    source.kind === 'hls' ||
    source.kind === 'mpegts' ||
    source.kind === 'file'
  );
}

function isNumericXtreamId(value: string): boolean {
  return /^\d{1,64}$/.test(value);
}

function mergeChatMessages(...lists: RoomChatMessage[][]): RoomChatMessage[] {
  const unique = new Map<string, RoomChatMessage>();
  for (const message of lists.flat()) unique.set(message.id, message);
  return [...unique.values()].sort((a, b) => a.sentAt - b.sentAt).slice(-100);
}

interface XtreamEpisodeResponse {
  id: string;
  name: string;
  episodeNumber: number;
  url: string;
  extension: string;
  subtitles?: SubtitleTrackSource[];
}

interface XtreamVodResponse {
  url: string;
  subtitles: SubtitleTrackSource[];
}

interface XtreamSeriesResponse {
  seriesId: string;
  episodesBySeason: Array<{
    seasonId: string;
    episodes: XtreamEpisodeResponse[];
  }>;
}

export function RoomPage({ user }: { user: User }) {
  const { signOut } = useAuth();
  const { state, reload } = useRoom(user.id);

  if (state.status === 'loading') {
    return <FullScreenLoader label="Sinema salonu hazırlanıyor…" />;
  }

  if (state.status === 'forbidden') {
    return (
      <CenteredCard
        title="Bu özel odaya erişiminiz yok"
        description="Hesabınız OurCinema odasına eklenmemiş. Yönetici sizi odaya eklemelidir."
      >
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          Çıkış yap
        </button>
      </CenteredCard>
    );
  }

  if (state.status === 'error') {
    return (
      <CenteredCard title="Oda açılamadı" description={state.message}>
        <button
          type="button"
          onClick={reload}
          className="rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          Tekrar dene
        </button>

        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-xl px-4 py-3 text-sm text-mist-300 hover:text-mist-100"
        >
          Çıkış yap
        </button>
      </CenteredCard>
    );
  }

  return (
    <Room
      data={state.data}
      user={user}
      onSignOut={() => void signOut()}
    />
  );
}

function describeActivity(
  kind: ActivityKind,
  isSelf: boolean,
  name: string,
  position: number,
): string {
  const t = formatTime(position);

  switch (kind) {
    case 'play':
      return isSelf ? `Videoyu başlattın · ${t}` : `${name} videoyu başlattı · ${t}`;

    case 'pause':
      return isSelf ? `Videoyu durdurdun · ${t}` : `${name} videoyu durdurdu · ${t}`;

    case 'seek':
      return isSelf
        ? `Videoyu ${t} konumuna aldın`
        : `${name} videoyu ${t} konumuna aldı`;

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
  const [channelStatus, setChannelStatus] =
    useState<ChannelStatus>('connecting');
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false,
  );
  const [activity, setActivity] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [chatMessages, setChatMessages] = useState<RoomChatMessage[]>([]);
  const [chatHistoryError, setChatHistoryError] = useState(false);
  const [isIptv, setIsIptv] = useState(false);
  const [iptvChannels, setIptvChannels] = useState<IptvChannel[]>([]);
  const [loadNonce, setLoadNonce] = useState(0);

  const engineRef = useRef<SyncEngine | null>(null);
  const roomChannelRef = useRef<RoomChannel | null>(null);
  const isIptvRef = useRef(false);
  const pendingIptvChannelIdRef = useRef<string | null>(null);
  const pendingIptvContentTypeRef = useRef<'live' | 'movie' | 'series'>('live');
  const episodeRequestRef = useRef(0);

  const partner = data.members.find((m) => m.userId !== user.id) ?? null;

  const nameOf = useCallback(
    (id: string) =>
      data.members.find((m) => m.userId === id)?.displayName ?? 'Partnerin',
    [data.members],
  );

  const showActivity = useCallback(
    (kind: ActivityKind, by: string, position: number) => {
      setActivity(
        `${describeActivity(kind, by === user.id, nameOf(by), position)} · ${new Date().toLocaleTimeString('tr-TR', {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      );
    },
    [nameOf, user.id],
  );

  /** Normal video bağlantısını yerel oynatıcıya uygular. */
  const applyUrl = useCallback(
    (url: string, sourceType: SourceKind | null) => {
      episodeRequestRef.current += 1;

      const result = detectSource(url, {
        forceFile: sourceType === 'file',
      });

      isIptvRef.current = false;
      pendingIptvChannelIdRef.current = null;
      setIsIptv(false);
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
    },
    [],
  );

  /**
   * Kanal kimliğini yerel IPTV listesinde bulur ve
   * o cihazın kendi yayın adresini açar.
   */
  const applyIptvChannel = useCallback(
    async (
      channelId: string,
      contentType: 'live' | 'movie' | 'series' = 'live',
      byUserId?: string,
      autoPlay?: boolean,
    ) => {
      const requestId = ++episodeRequestRef.current;

      const channel = iptvChannels.find((item) => item.id === channelId);
      let channelName = channel?.name ?? (contentType === 'movie' ? 'Film' : 'IPTV içeriği');
      let channelUrl = channel?.url ?? '';
      let subtitleTracks = channel?.subtitleTracks ?? [];

      if (!channel && contentType !== 'movie') {
        pendingIptvChannelIdRef.current = channelId;
        pendingIptvContentTypeRef.current = contentType;
        setPlayerError('Seçilen IPTV öğesi liste yüklenince açılacak.');
        return;
      }
      pendingIptvChannelIdRef.current = null;

      if (contentType === 'movie') {
        try {
          const response = await iptvFetch(
            `/api/iptv/xtream/vod/${encodeURIComponent(channelId)}`,
          );
          const data = (await response.json()) as
            | XtreamVodResponse
            | { error?: string };

          if (!response.ok) {
            throw new Error(
              'error' in data && data.error
                ? data.error
                : 'Film altyazı bilgileri alınamadı.',
            );
          }

          if (requestId !== episodeRequestRef.current) return;
          if ('url' in data) {
            channelUrl = data.url;
            subtitleTracks = data.subtitles;
          }
        } catch (error) {
          if (requestId !== episodeRequestRef.current) return;
          setPlayerError(
            error instanceof Error
              ? error.message
              : 'Film altyazı bilgileri alınamadı.',
          );
          return;
        }
      }

      const result = detectSource(channelUrl, {
        iptv: true,
        contentType,
      });

      if (!result.ok) {
        setPlayerError(`${channelName}: ${result.message}`);
        return;
      }

      if (!isSupportedIptvSource(result.source)) {
        setPlayerError(
          `${channelName}: Bu yayın formatı desteklenmiyor.`,
        );
        return;
      }

      let playbackUrl: string;
      try {
        playbackUrl = await authorizeIptvPlaybackUrl(result.source.url);
      } catch (error) {
        if (requestId !== episodeRequestRef.current) return;
        setPlayerError(error instanceof Error ? error.message : 'IPTV oturumu doğrulanamadı.');
        return;
      }
      if (requestId !== episodeRequestRef.current) return;

      isIptvRef.current = true;
      setIsIptv(true);

      engineRef.current?.detach();

      setLoadNonce((n) => n + 1);
      setSource({
        ...result.source,
        url: playbackUrl,
        isLive: contentType === 'live',
        ...(autoPlay === undefined ? {} : { autoPlay }),
        subtitleTracks,
      });
      setFailure(null);
      setPlayerError(null);
      setNeedsGesture(false);

      if (byUserId) {
        setActivity(`${nameOf(byUserId)} ${channelName} içeriğini seçti`);
      } else {
        setActivity(`${channelName} açılıyor`);
      }
    },
    [iptvChannels, nameOf],
  );

  /**
   * Xtream API üzerinden dizi bölümünü bulur ve
   * yerel oynatıcıda açar.
   *
   * Supabase'e bölüm URL'si gönderilmez.
   */
  const applyIptvEpisode = useCallback(
    async (
      seriesId: string,
      episodeId: string,
      byUserId?: string,
      autoPlay?: boolean,
    ) => {
      if (
        !isNumericXtreamId(seriesId) ||
        !isNumericXtreamId(episodeId)
      ) {
        setPlayerError('Geçersiz dizi veya bölüm kimliği.');
        return;
      }

      const requestId = ++episodeRequestRef.current;

      try {
        setPlayerError(null);
        setFailure(null);
        setNeedsGesture(false);

        const response = await iptvFetch(
          `/api/iptv/xtream/series/${encodeURIComponent(seriesId)}`,
        );

        const data = (await response.json()) as
          | XtreamSeriesResponse
          | { error?: string };

        // Bu sırada başka bir içerik seçildiyse eski isteği yok say.
        if (requestId !== episodeRequestRef.current) {
          return;
        }

        if (!response.ok) {
          throw new Error(
            'error' in data && data.error
              ? data.error
              : 'Dizi bilgileri alınamadı.',
          );
        }

        if (
          !('episodesBySeason' in data) ||
          !Array.isArray(data.episodesBySeason)
        ) {
          throw new Error('Sunucudan geçersiz dizi bilgisi alındı.');
        }

        const episode = data.episodesBySeason
          .flatMap((season) => season.episodes)
          .find((item) => item.id === episodeId);

        if (!episode || typeof episode.url !== 'string') {
          throw new Error(
            'Seçilen bölüm bu Xtream hesabında bulunamadı.',
          );
        }

        const result = detectSource(episode.url, {
          iptv: true,
          contentType: 'series',
        });

        if (!result.ok) {
          throw new Error(result.message);
        }

        if (!isSupportedIptvSource(result.source)) {
          throw new Error('Bu bölümün yayın formatı desteklenmiyor.');
        }
        const playbackUrl = await authorizeIptvPlaybackUrl(result.source.url);
        if (requestId !== episodeRequestRef.current) return;

        isIptvRef.current = true;
        pendingIptvChannelIdRef.current = null;

        setIsIptv(true);

        engineRef.current?.detach();

        setLoadNonce((n) => n + 1);

        setSource({
          ...result.source,
          url: playbackUrl,
          isLive: false,
          ...(autoPlay === undefined ? {} : { autoPlay }),
          subtitleTracks: episode.subtitles,
        });

        setFailure(null);
        setPlayerError(null);
        setNeedsGesture(false);

        setActivity(
          byUserId
            ? `${nameOf(byUserId)} bir dizi bölümü seçti`
            : 'Dizi bölümü açılıyor',
        );
      } catch (error) {
        if (requestId !== episodeRequestRef.current) {
          return;
        }

        setPlayerError(
          error instanceof Error
            ? error.message
            : 'Dizi bölümü yüklenirken bir hata oluştu.',
        );
      }
    },
    [nameOf],
  );

  /** M3U listesi yüklendiğinde bekleyen kanal seçimini uygular. */
  const handleChannelsLoaded = useCallback(
    (channels: IptvChannel[]) => {
      setIptvChannels(channels);

      const pendingId = pendingIptvChannelIdRef.current;

      if (pendingId) {
        const channel = channels.find((item) => item.id === pendingId);

        if (channel) {
          void applyIptvChannel(channel.id, pendingIptvContentTypeRef.current);
        } else {
          setPlayerError(
            'Partnerinin seçtiği kanal bu M3U listesinde bulunamadı.',
          );
        }
      }
    },
    [applyIptvChannel],
  );

  // ----------------------------------------------------------------
  // Bağlantı ve senkronizasyon
  // ----------------------------------------------------------------

  useEffect(() => {
    const supabase = getSupabase();
    const channel = new RoomChannel(supabase, data.roomId, user.id);
    roomChannelRef.current = channel;
    setChatMessages([]);
    setChatHistoryError(false);
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
        .then(() => {
          if (!disposed) setSaveFailed(false);
        })
        .catch(() => {
          if (!disposed) setSaveFailed(true);
        });
    };

    const engine = new SyncEngine(user.id, channel, clock, {
      onRemoteLoad: (url, sourceType) => {
        if (!disposed) applyUrl(url, sourceType);
      },

      onRemoteIptvLoad: (channelId, contentType, byUserId, autoPlay) => {
        if (!disposed) void applyIptvChannel(channelId, contentType, byUserId, autoPlay);
      },

      onRemoteIptvEpisodeLoad: (seriesId, episodeId, byUserId, autoPlay) => {
        if (!disposed) {
          void applyIptvEpisode(seriesId, episodeId, byUserId, autoPlay);
        }
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

    const offPresence = channel.onPresence((ids) => {
      if (!disposed) setOnlineIds(ids);
    });

    const offChat = channel.onChatMessage((message) => {
      if (!disposed) {
        setChatMessages((current) => mergeChatMessages(current, [message]));
      }
    });

    void fetchRecentRoomChat(supabase, data.roomId)
      .then((messages) => {
        if (!disposed) setChatMessages((current) => mergeChatMessages(current, messages));
      })
      .catch(() => {
        if (!disposed) setChatHistoryError(true);
      });

    const offStatus = channel.onStatus((status) => {
      if (disposed) return;

      setChannelStatus(status);

      if (status === 'reconnecting' || status === 'error') {
        wasDisconnected = true;
      }

      if (status === 'connected') {
        if (wasDisconnected) {
          wasDisconnected = false;

          fetchRoomState(supabase, data.roomId)
            .then((row) => {
              if (!disposed && row) {
                engine.hydrate(row, 1.5);
              }
            })
            .catch(() => undefined);
        }

        engine.requestState();
      }
    });

    (async () => {
      await clock.calibrate(() => fetchServerTime(supabase));

      if (disposed) return;

      if (data.initialState) {
        engine.hydrate(data.initialState, undefined, true);
      }

      await channel.connect();
    })().catch(() => {
      if (!disposed) setChannelStatus('error');
    });

    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        engine.requestState();
      }
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
      offChat();
      offStatus();

      engine.stop();
      channel.disconnect();

      engineRef.current = null;
      roomChannelRef.current = null;
    };
  }, [
    data.roomId,
    user.id,
    applyUrl,
    applyIptvChannel,
    applyIptvEpisode,
    showActivity,
  ]);

  // Kontrol API'si olmayan kaynaklarda senkronizasyon devre dışı.
  useEffect(() => {
    if (source && !source.syncCapable && !isIptvRef.current) {
      engineRef.current?.attach(null, false);
    }
  }, [source, isIptv]);

  // ----------------------------------------------------------------
  // Oynatıcı olayları
  // ----------------------------------------------------------------

  const callbacks = useMemo<PlayerCallbacks>(
    () => ({
      onReady: (controller) => {
        setPlayerError(null);

        if (isIptvRef.current) {
          engineRef.current?.attachIptv(controller);
          return;
        }

        engineRef.current?.attach(controller, true);
      },

      onPlay: (t) => {
        const synced = isIptvRef.current
          ? engineRef.current?.localIptvPlay()
          : engineRef.current?.localPlay(t);
        if (synced) {
          showActivity('play', user.id, t);
        }
      },

      onPause: (t) => {
        const synced = isIptvRef.current
          ? engineRef.current?.localIptvPause()
          : engineRef.current?.localPause(t);
        if (synced) {
          showActivity('pause', user.id, t);
        }
      },

      onSeek: (t) => {
        if (engineRef.current?.localSeek(t)) {
          showActivity('seek', user.id, t);
        }
      },

      onError: (message) => {
        setPlayerError(message);
        setNeedsGesture(false);
      },
    }),
    [showActivity, user.id],
  );

  /** Normal video kaynağını açar ve diğer kullanıcıya bildirir. */
  const startSource = useCallback(
    (next: VideoSource) => {
      episodeRequestRef.current += 1;

      isIptvRef.current = false;
      pendingIptvChannelIdRef.current = null;
      setIsIptv(false);

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

  /** URL çubuğundan gelen normal video bağlantısını işler. */
  const handleSubmit = useCallback(
    (raw: string): string | null => {
      const result = detectSource(raw);

      if (result.ok) {
        startSource(result.source);
        return null;
      }

      if (
        result.reason === 'empty' ||
        result.reason === 'invalid' ||
        result.reason === 'insecure'
      ) {
        return result.message;
      }

      episodeRequestRef.current += 1;

      isIptvRef.current = false;
      pendingIptvChannelIdRef.current = null;
      setIsIptv(false);

      engineRef.current?.detach();

      setSource(null);
      setPlayerError(null);
      setNeedsGesture(false);
      setFailure(result);

      return null;
    },
    [startSource],
  );

  /** Kullanıcının bağlantıyı dosya olarak denemesini sağlar. */
  const handleTryAsFile = useCallback(
    (url: string) => {
      const result = detectSource(url, { forceFile: true });

      if (result.ok) startSource(result.source);
    },
    [startSource],
  );

  /** IPTV kanalını veya dizi bölümünü açar ve senkronize eder. */
  const handleSelectIptvChannel = useCallback(
    async (channel: IptvChannel) => {
      const requestId = ++episodeRequestRef.current;
      const result = detectSource(channel.url, {
        iptv: true,
        contentType: channel.type,
      });

      if (!result.ok) {
        setPlayerError(`${channel.name}: ${result.message}`);
        return;
      }

      if (!isSupportedIptvSource(result.source)) {
        setPlayerError(
          `${channel.name}: Bu yayın formatı desteklenmiyor.`,
        );
        return;
      }

      let playbackUrl: string;
      try {
        playbackUrl = await authorizeIptvPlaybackUrl(result.source.url);
      } catch (error) {
        if (requestId !== episodeRequestRef.current) return;
        setPlayerError(error instanceof Error ? error.message : 'IPTV oturumu doğrulanamadı.');
        return;
      }
      if (requestId !== episodeRequestRef.current) return;

      // Dizi bölümü için iki kimlik de zorunludur.
      if (channel.type === 'series') {
        if (
          !channel.seriesId ||
          !channel.episodeId ||
          !isNumericXtreamId(channel.seriesId) ||
          !isNumericXtreamId(channel.episodeId)
        ) {
          setPlayerError(
            'Dizi veya bölüm kimliği geçersiz. Bölümü yeniden seç.',
          );
          return;
        }
      }

      isIptvRef.current = true;
      pendingIptvChannelIdRef.current = null;
      setIsIptv(true);

      if (channel.type === 'series') {
        // Yalnızca sayısal kimlikler senkronizasyon mesajına eklenir.
        engineRef.current?.loadIptvEpisode(
          channel.seriesId!,
          channel.episodeId!,
        );
      } else {
        engineRef.current?.loadIptvChannel(channel.id, channel.type);
      }

      setLoadNonce((n) => n + 1);

      setSource({
        ...result.source,
        url: playbackUrl,
        isLive: channel.type === 'live',
        subtitleTracks: channel.subtitleTracks,
      });

      setFailure(null);
      setPlayerError(null);
      setNeedsGesture(false);
      setActivity(`${channel.name} açılıyor`);
    },
    [],
  );

  const handleGesture = useCallback(() => {
    if (!isIptvRef.current) {
      void engineRef.current?.resumeFromGesture();
    }
  }, []);

  const sendChatMessage = useCallback(async (text: string) => {
    if (channelStatus !== 'connected') throw new Error('Oda bağlantısı yok.');
    const message = await saveRoomChatMessage(
      getSupabase(),
      data.roomId,
      text.trim().slice(0, 1000),
    );
    setChatMessages((current) => mergeChatMessages(current, [message]));
    roomChannelRef.current?.sendChat(message);
  }, [channelStatus, data.roomId]);

  // ----------------------------------------------------------------
  // Durum mesajı
  // ----------------------------------------------------------------

  const partnerOnline = partner
    ? onlineIds.includes(partner.userId)
    : false;

  const status = useMemo<StatusMessage>(() => {
    if (isOffline) {
      return {
        tone: 'error',
        text: 'İnternet bağlantısı yok. Bağlantı geri geldiğinde senkronizasyon kaldığı yerden devam edecek.',
      };
    }

    if (channelStatus === 'error') {
      return {
        tone: 'error',
        text: 'Gerçek zamanlı bağlantı kurulamadı. Yeniden deneniyor; sorun sürerse sayfayı yenileyin.',
      };
    }

    if (channelStatus === 'reconnecting') {
      return {
        tone: 'warn',
        text: 'Bağlantı koptu, yeniden bağlanılıyor…',
      };
    }

    if (channelStatus === 'connecting') {
      return {
        tone: 'info',
        text: 'Odaya bağlanılıyor…',
      };
    }

    if (playerError) {
      return {
        tone: 'error',
        text: playerError,
      };
    }

    if (failure) {
      return {
        tone: 'warn',
        text: 'Bu bağlantı burada oynatılamıyor; yalnızca sizin ekranınızda gösteriliyor.',
      };
    }

    if (isIptv) {
      return {
        tone: 'success',
        text: 'IPTV seçimi ve oynat/durdur kontrolleri odadaki herkesle senkronize edilir.',
      };
    }

    if (source && !source.syncCapable) {
      return {
        tone: 'warn',
        text: `${source.platformLabel} oynatıcısı dışarıdan kontrol edilemiyor: video ikinize de açıldı ama oynatma/durdurma senkronize edilmez. Birlikte manuel başlatın.`,
      };
    }

    if (saveFailed) {
      return {
        tone: 'warn',
        text: 'Oda durumu kaydedilemedi; canlı senkronizasyon devam ediyor.',
      };
    }

    if (!partnerOnline) {
      return {
        tone: 'info',
        text: `${partner?.displayName ?? 'Partnerin'} henüz çevrimiçi değil. Katıldığında video otomatik olarak eşitlenecek.`,
      };
    }

    if (!source) {
      return {
        tone: 'success',
        text: 'İkiniz de buradasınız. Bir bağlantı ekleyip izlemeye başlayın.',
      };
    }

    return {
      tone: 'success',
      text: `Senkronize · ${source.platformLabel}`,
    };
  }, [
    isOffline,
    channelStatus,
    playerError,
    failure,
    isIptv,
    source,
    saveFailed,
    partnerOnline,
    partner,
  ]);

  return (
    <div className="min-h-[100dvh]">
      <TopBar
        members={data.members}
        onlineIds={onlineIds}
        onSignOut={onSignOut}
      />

      <main
        className="grid min-h-[calc(100dvh-4rem)] grid-cols-1 gap-4 px-4 pb-10 pt-5 sm:gap-5 sm:px-6 sm:pt-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:gap-0 lg:px-0 lg:pb-0 lg:pt-0"
      >
        <aside className="min-w-0 lg:sticky lg:top-16 lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:p-3 lg:pl-4">
          <RoomChat
            members={data.members}
            currentUserId={user.id}
            messages={chatMessages}
            connected={channelStatus === 'connected'}
            historyError={chatHistoryError}
            onSend={sendChatMessage}
          />
        </aside>

        <section className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-4 sm:gap-5 lg:px-8 lg:py-6">
          <PresenceBar
            members={data.members}
            onlineIds={onlineIds}
            currentUserId={user.id}
          />

          <UrlBar onSubmit={handleSubmit} />

          <IptvPanel
            onSelectChannel={handleSelectIptvChannel}
            onChannelsLoaded={handleChannelsLoaded}
          />

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
            Tam senkronizasyon: MP4/WebM, HLS (m3u8), YouTube, Vimeo ·
            IPTV: MP4, HLS ve MPEG-TS · Yalnızca gömme: Dailymotion, Twitch
          </p>
        </section>
      </main>
    </div>
  );
}
