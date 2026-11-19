
import {
  AutoplayBlockedError,
  type PlayerController,
  type SourceKind,
} from '../player/types';
import type { RoomChannel } from '../realtime/RoomChannel';
import type { ServerClock } from './serverClock';
import type {
  PersistPayload,
  RoomStateRow,
  SyncMessage,
  SyncPayload,
} from './types';

const SEEK_TOLERANCE = 0.75;
const DRIFT_TOLERANCE = 1.5;
const SUPPRESS_MS = 1200;
const HEARTBEAT_MS = 4000;
const MAX_LATENCY_COMPENSATION_S = 5;

export type ActivityKind = 'play' | 'pause' | 'seek' | 'load';

export interface SyncEngineHooks {
  onRemoteLoad(
    url: string,
    sourceType: SourceKind | null,
    byUserId: string | null,
  ): void;
  onRemoteIptvLoad(
    channelId: string,
    contentType: 'live' | 'movie' | 'series',
    byUserId: string,
    autoPlay: boolean,
  ): void;
  onActivity(
    kind: ActivityKind,
    byUserId: string,
    position: number,
  ): void;
  onNeedsGesture(needed: boolean): void;
  persist(state: PersistPayload): void;
  onRemoteIptvEpisodeLoad(
    seriesId: string,
    episodeId: string,
    byUserId: string,
    autoPlay: boolean,
  ): void;
}

interface Expected {
  url: string | null;
  sourceType: SourceKind | null;
  position: number;
  playing: boolean;
  at: number;
}

export class SyncEngine {
  private controller: PlayerController | null = null;
  private syncCapable = false;
  private iptvSession = false;
  private iptvPlaybackKnown = false;
  private iptvSelection: Pick<
    PersistPayload,
    'iptv_channel_id' | 'iptv_content_type' | 'iptv_series_id' | 'iptv_episode_id'
  > = {
    iptv_channel_id: null,
    iptv_content_type: null,
    iptv_series_id: null,
    iptv_episode_id: null,
  };
  private suppressUntil = 0;
  private leaderId: string | null = null;

  private expected: Expected = {
    url: null,
    sourceType: null,
    position: 0,
    playing: false,
    at: 0,
  };

  private heartbeatTimer: number | undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly userId: string,
    private readonly channel: RoomChannel,
    private readonly clock: ServerClock,
    private readonly hooks: SyncEngineHooks,
  ) { }

  start(): void {
    this.unsubscribe = this.channel.onMessage((m) =>
      this.handleRemote(m),
    );

    this.heartbeatTimer = window.setInterval(
      () => this.tick(),
      HEARTBEAT_MS,
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    if (this.heartbeatTimer !== undefined) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    this.controller = null;
  }

  /**
   * Veritabanındaki kalıcı durumu uygular.
   *
   * preventYoutubeAutoplay:
   * Sayfanın ilk açılışında eski YouTube videosunun
   * kendiliğinden başlamasını engeller.
   */
  hydrate(
    row: RoomStateRow,
    tolerance = SEEK_TOLERANCE,
    preventYoutubeAutoplay = false,
  ): void {
    if (!row.video_url) {
      if (row.iptv_channel_id && row.iptv_content_type) {
        this.leaderId = row.updated_by;
        this.iptvSession = true;
        this.iptvPlaybackKnown = true;
        this.iptvSelection = {
          iptv_channel_id: row.iptv_channel_id,
          iptv_content_type: row.iptv_content_type,
          iptv_series_id: null,
          iptv_episode_id: null,
        };
        this.expected = {
          url: null,
          sourceType: null,
          position: row.position_seconds,
          playing: row.is_playing,
          at: Number.isFinite(Date.parse(row.updated_at))
            ? Date.parse(row.updated_at)
            : this.clock.now(),
        };
        this.hooks.onRemoteIptvLoad(
          row.iptv_channel_id,
          row.iptv_content_type,
          row.updated_by ?? this.userId,
          row.is_playing,
        );
        return;
      }

      if (row.iptv_series_id && row.iptv_episode_id) {
        this.leaderId = row.updated_by;
        this.iptvSession = true;
        this.iptvPlaybackKnown = true;
        this.iptvSelection = {
          iptv_channel_id: null,
          iptv_content_type: 'series',
          iptv_series_id: row.iptv_series_id,
          iptv_episode_id: row.iptv_episode_id,
        };
        this.expected = {
          url: null,
          sourceType: null,
          position: row.position_seconds,
          playing: row.is_playing,
          at: Number.isFinite(Date.parse(row.updated_at))
            ? Date.parse(row.updated_at)
            : this.clock.now(),
        };
        this.hooks.onRemoteIptvEpisodeLoad(
          row.iptv_series_id,
          row.iptv_episode_id,
          row.updated_by ?? this.userId,
          row.is_playing,
        );
      }
      return;
    }

    this.iptvSelection = {
      iptv_channel_id: null,
      iptv_content_type: null,
      iptv_series_id: null,
      iptv_episode_id: null,
    };

    if (preventYoutubeAutoplay && row.source_type === 'youtube') {
      return;
    }

    const at = Date.parse(row.updated_at);
    this.leaderId = row.updated_by;

    const shouldPauseYoutube =
      preventYoutubeAutoplay &&
      row.source_type === 'youtube';

    this.adopt(
      {
        url: row.video_url,
        sourceType: row.source_type,
        position: row.position_seconds,
        playing: shouldPauseYoutube ? false : row.is_playing,
        at: Number.isFinite(at) ? at : this.clock.now(),
      },
      null,
      tolerance,
    );
  }

  requestState(): void {
    this.send({ type: 'request_state' });
  }

  attach(
    controller: PlayerController | null,
    syncCapable: boolean,
  ): void {
    this.iptvSession = false;
    this.iptvPlaybackKnown = false;
    this.controller = controller;
    this.syncCapable = Boolean(controller) && syncCapable;

    if (this.syncCapable) {
      this.applyExpected(SEEK_TOLERANCE);
    }
  }

  detach(): void {
    this.controller = null;
    this.syncCapable = false;
  }

  attachIptv(controller: PlayerController): void {
    this.controller = controller;
    this.syncCapable = false;
    this.iptvSession = true;
    if (
      this.iptvSelection.iptv_content_type !== 'live' &&
      (this.iptvSelection.iptv_channel_id || this.iptvSelection.iptv_episode_id)
    ) {
      const position = this.projectedPosition();
      if (Math.abs(controller.getCurrentTime() - position) > SEEK_TOLERANCE) {
        controller.seek(position);
      }
    }
    this.applyIptvPlayback();
  }

  localIptvPlay(): boolean {
    return this.localIptvAction(true);
  }

  localIptvPause(): boolean {
    return this.localIptvAction(false);
  }

  // --------------------------------------------------
  // Yerel işlemler
  // --------------------------------------------------

  loadVideo(url: string, sourceType: SourceKind): void {
    this.leaderId = this.userId;
    this.iptvSession = false;

    this.expected = {
      url,
      sourceType,
      position: 0,
      playing: false,
      at: this.clock.now(),
    };

    this.iptvSelection = {
      iptv_channel_id: null,
      iptv_content_type: null,
      iptv_series_id: null,
      iptv_episode_id: null,
    };

    this.detach();
    this.iptvSession = false;
    this.hooks.onNeedsGesture(false);

    this.send({ type: 'load', url, sourceType });
    this.persistExpected();
  }

  loadIptvChannel(channelId: string, contentType: 'live' | 'movie' | 'series' = 'live'): void {
    const normalizedId = channelId.trim();

    if (!normalizedId || normalizedId.length > 256) return;

    this.leaderId = this.userId;

    this.expected = {
      url: null,
      sourceType: null,
      position: 0,
      playing: false,
      at: this.clock.now(),
    };
    this.iptvSelection = {
      iptv_channel_id: normalizedId,
      iptv_content_type: contentType,
      iptv_series_id: null,
      iptv_episode_id: null,
    };

    this.detach();
    this.iptvSession = true;
    this.iptvPlaybackKnown = false;
    this.hooks.onNeedsGesture(false);

    this.send({
      type: 'iptv_load',
      channelId: normalizedId,
      contentType,
    });
    this.persistExpected();
  }

  loadIptvEpisode(seriesId: string, episodeId: string): void {
    const normalizedSeriesId = seriesId.trim();
    const normalizedEpisodeId = episodeId.trim();

    if (
      !/^\d+$/.test(normalizedSeriesId) ||
      !/^\d+$/.test(normalizedEpisodeId) ||
      normalizedSeriesId.length > 64 ||
      normalizedEpisodeId.length > 64
    ) {
      return;
    }

    this.leaderId = this.userId;

    this.expected = {
      url: null,
      sourceType: null,
      position: 0,
      playing: false,
      at: this.clock.now(),
    };
    this.iptvSelection = {
      iptv_channel_id: null,
      iptv_content_type: 'series',
      iptv_series_id: normalizedSeriesId,
      iptv_episode_id: normalizedEpisodeId,
    };

    this.detach();
    this.iptvSession = true;
    this.iptvPlaybackKnown = false;
    this.hooks.onNeedsGesture(false);

    this.send({
      type: 'iptv_episode_load',
      seriesId: normalizedSeriesId,
      episodeId: normalizedEpisodeId,
    });
    this.persistExpected();
  }

  localPlay(position: number): boolean {
    if (!this.acceptLocal()) return false;

    this.hooks.onNeedsGesture(false);
    this.commit(position, true);

    this.send({
      type: 'play',
      url: this.expected.url as string,
      sourceType: this.expected.sourceType,
      position,
    });

    return true;
  }

  localPause(position: number): boolean {
    if (!this.acceptLocal()) return false;

    this.commit(position, false);

    this.send({
      type: 'pause',
      url: this.expected.url as string,
      sourceType: this.expected.sourceType,
      position,
    });

    return true;
  }

  localSeek(position: number): boolean {
    if (this.iptvSession) {
      if (!this.isSeekableIptv() || !this.controller) return false;
      if (performance.now() < this.suppressUntil) return false;

      const playing = !this.controller.isPaused();
      this.leaderId = this.userId;
      this.iptvPlaybackKnown = true;
      this.expected = {
        ...this.expected,
        position,
        playing,
        at: this.clock.now(),
      };
      this.send({ type: 'iptv_seek', position, playing });
      this.persistExpected();
      return true;
    }

    if (!this.acceptLocal()) return false;

    const playing = this.controller
      ? !this.controller.isPaused()
      : this.expected.playing;

    this.commit(position, playing);

    this.send({
      type: 'seek',
      url: this.expected.url as string,
      sourceType: this.expected.sourceType,
      position,
      playing,
    });

    return true;
  }

  async resumeFromGesture(): Promise<void> {
    const c = this.controller;
    if (!c) return;

    const target = this.projectedPosition();

    this.suppress();

    if (
      Math.abs(c.getCurrentTime() - target) >
      SEEK_TOLERANCE
    ) {
      c.seek(target);
    }

    try {
      await c.play();
      this.hooks.onNeedsGesture(false);
    } catch (err) {
      this.hooks.onNeedsGesture(
        err instanceof AutoplayBlockedError,
      );
    }
  }

  // --------------------------------------------------
  // Uzak işlemler
  // --------------------------------------------------

  private handleRemote(msg: SyncMessage): void {
    if (msg.by === this.userId) return;

    switch (msg.type) {
      case 'request_state':
        if (this.iptvSession) {
          const state: SyncPayload = {
            type: 'iptv_state',
            playing: this.controller ? !this.controller.isPaused() : this.expected.playing,
          };
          if (this.isSeekableIptv()) {
            state.position = this.controller?.getCurrentTime() ?? this.expected.position;
          }
          this.send(state);
        } else if (this.expected.url) {
          this.send(this.snapshot(true));
        }
        return;

      case 'iptv_load':
        this.leaderId = msg.by;
        this.detach();
        this.iptvSession = true;
        this.iptvPlaybackKnown = false;
        this.iptvSelection = {
          iptv_channel_id: msg.channelId,
          iptv_content_type: msg.contentType,
          iptv_series_id: null,
          iptv_episode_id: null,
        };

        this.expected = {
          url: null,
          sourceType: null,
          position: 0,
          playing: false,
          at: this.clock.now(),
        };

        this.hooks.onNeedsGesture(false);
        this.hooks.onActivity('load', msg.by, 0);
        this.hooks.onRemoteIptvLoad(msg.channelId, msg.contentType, msg.by, true);
        return;

      case 'iptv_play':
      case 'iptv_pause':
        this.leaderId = msg.by;
        this.iptvPlaybackKnown = true;
        this.expected = {
          ...this.expected,
          position: msg.position ?? this.expected.position,
          playing: msg.type === 'iptv_play',
          at: this.messageTime(msg.sentAt),
        };
        this.applyIptvPlayback();
        this.hooks.onActivity(msg.type === 'iptv_play' ? 'play' : 'pause', msg.by, 0);
        return;

      case 'iptv_seek':
        this.leaderId = msg.by;
        this.iptvPlaybackKnown = true;
        this.expected = {
          ...this.expected,
          position: msg.position,
          playing: msg.playing,
          at: this.messageTime(msg.sentAt),
        };
        this.applyIptvPlayback();
        this.hooks.onActivity('seek', msg.by, msg.position);
        return;

      case 'iptv_state':
        this.leaderId = msg.by;
        this.iptvPlaybackKnown = true;
        this.expected = {
          ...this.expected,
          position: msg.position ?? this.expected.position,
          playing: msg.playing,
          at: msg.position === undefined ? this.clock.now() : this.messageTime(msg.sentAt),
        };
        this.applyIptvPlayback();
        return;

      case 'load':
        this.leaderId = msg.by;
        this.hooks.onActivity('load', msg.by, 0);

        this.adopt(
          {
            url: msg.url,
            sourceType: msg.sourceType,
            position: 0,
            playing: false,
            at: msg.sentAt,
          },
          msg.by,
          SEEK_TOLERANCE,
          true,
        );
        return;

      case 'play':
      case 'pause':
      case 'seek': {
        this.leaderId = msg.by;

        const playing =
          msg.type === 'play'
            ? true
            : msg.type === 'pause'
              ? false
              : msg.playing;

        this.hooks.onActivity(
          msg.type,
          msg.by,
          msg.position,
        );

        this.adopt(
          {
            url: msg.url,
            sourceType: msg.sourceType,
            position: msg.position,
            playing,
            at: this.messageTime(msg.sentAt),
          },
          msg.by,
          SEEK_TOLERANCE,
        );
        return;
      }
      case 'iptv_episode_load':
        this.leaderId = msg.by;
        this.detach();
        this.iptvSession = true;
        this.iptvPlaybackKnown = false;
        this.iptvSelection = {
          iptv_channel_id: null,
          iptv_content_type: 'series',
          iptv_series_id: msg.seriesId,
          iptv_episode_id: msg.episodeId,
        };

        this.expected = {
          url: null,
          sourceType: null,
          position: 0,
          playing: false,
          at: this.clock.now(),
        };

        this.hooks.onNeedsGesture(false);
        this.hooks.onActivity('load', msg.by, 0);

        this.hooks.onRemoteIptvEpisodeLoad(
          msg.seriesId,
          msg.episodeId,
          msg.by,
          true,
        );

        return;

      case 'state': {
        if (
          !msg.reply &&
          this.leaderId === this.userId
        ) {
          return;
        }

        if (
          msg.reply &&
          this.leaderId === this.userId &&
          this.controller &&
          this.syncCapable &&
          msg.url === this.expected.url
        ) {
          return;
        }

        if (!msg.reply) {
          this.leaderId = msg.by;
        }

        this.adopt(
          {
            url: msg.url,
            sourceType: msg.sourceType,
            position: msg.position,
            playing: msg.playing,
            at: this.messageTime(msg.sentAt),
          },
          msg.by,
          DRIFT_TOLERANCE,
        );
        return;
      }
    }
  }

  private adopt(
    next: Expected,
    by: string | null,
    tolerance: number,
    forceReload = false,
  ): void {
    const urlChanged =
      forceReload || next.url !== this.expected.url;

    this.expected = next;

    if (urlChanged && next.url) {
      this.iptvSession = false;
      this.iptvPlaybackKnown = false;
      this.iptvSelection = {
        iptv_channel_id: null,
        iptv_content_type: null,
        iptv_series_id: null,
        iptv_episode_id: null,
      };
      this.detach();
      this.hooks.onNeedsGesture(false);

      this.hooks.onRemoteLoad(
        next.url,
        next.sourceType,
        by,
      );

      return;
    }

    this.applyExpected(tolerance);
  }

  private applyExpected(tolerance: number): void {
    const c = this.controller;

    if (
      !c ||
      !this.syncCapable ||
      !this.expected.url
    ) {
      return;
    }

    const target = this.projectedPosition();
    const paused = c.isPaused();

    const needSeek =
      Math.abs(c.getCurrentTime() - target) > tolerance;

    const needPlay =
      this.expected.playing && paused;

    const needPause =
      !this.expected.playing && !paused;

    if (!this.expected.playing) {
      this.hooks.onNeedsGesture(false);
    }

    if (!needSeek && !needPlay && !needPause) return;

    this.suppress();

    if (needSeek) c.seek(target);
    if (needPause) c.pause();

    if (needPlay) {
      c.play()
        .then(() => this.hooks.onNeedsGesture(false))
        .catch((err: unknown) => {
          if (err instanceof AutoplayBlockedError) {
            this.hooks.onNeedsGesture(true);
          }
        });
    }
  }

  private localIptvAction(playing: boolean): boolean {
    if (!this.iptvSession || !this.controller) return false;
    if (performance.now() < this.suppressUntil) return false;

    this.leaderId = this.userId;
    this.iptvPlaybackKnown = true;
    this.expected = {
      ...this.expected,
      playing,
      position: this.controller.getCurrentTime(),
      at: this.clock.now(),
    };
    this.send(this.isSeekableIptv()
      ? { type: playing ? 'iptv_play' : 'iptv_pause', position: this.expected.position }
      : { type: playing ? 'iptv_play' : 'iptv_pause' });
    this.persistExpected();
    return true;
  }

  private applyIptvPlayback(): void {
    const controller = this.controller;
    if (!this.iptvSession || !controller || !this.iptvPlaybackKnown) return;

    const paused = controller.isPaused();
    const target = this.projectedPosition();
    const needSeek = this.isSeekableIptv() &&
      Math.abs(controller.getCurrentTime() - target) > DRIFT_TOLERANCE;
    const needPlay = this.expected.playing && paused;
    const needPause = !this.expected.playing && !paused;
    if (!needSeek && !needPlay && !needPause) return;

    this.suppress();
    if (needSeek) controller.seek(target);
    if (!this.expected.playing) {
      if (needPause) controller.pause();
      return;
    }

    if (needPlay) {
      controller.play().then(() => this.hooks.onNeedsGesture(false)).catch((err: unknown) => {
        this.hooks.onNeedsGesture(err instanceof AutoplayBlockedError);
      });
    }
  }

  private isSeekableIptv(): boolean {
    return this.iptvSelection.iptv_content_type === 'movie' ||
      this.iptvSelection.iptv_content_type === 'series';
  }

  // --------------------------------------------------
  // Yardımcılar
  // --------------------------------------------------

  private tick(): void {
    const c = this.controller;

    if (this.iptvSession) {
      if (
        !c ||
        !this.isSeekableIptv() ||
        this.leaderId !== this.userId ||
        c.isPaused()
      ) return;

      this.expected = {
        ...this.expected,
        position: c.getCurrentTime(),
        playing: true,
        at: this.clock.now(),
      };
      this.send({ type: 'iptv_state', position: this.expected.position, playing: true });
      return;
    }

    if (
      !c ||
      !this.syncCapable ||
      !this.expected.url
    ) {
      return;
    }

    if (
      this.leaderId !== this.userId ||
      c.isPaused()
    ) {
      return;
    }

    this.expected = {
      ...this.expected,
      position: c.getCurrentTime(),
      playing: true,
      at: this.clock.now(),
    };

    this.send(this.snapshot(false));
  }

  private snapshot(reply: boolean): SyncPayload {
    const c = this.controller;

    let position = this.projectedPosition();
    let playing = this.expected.playing;

    if (c && this.syncCapable) {
      position = c.getCurrentTime();
      playing = !c.isPaused();
    }

    return {
      type: 'state',
      url: this.expected.url as string,
      sourceType: this.expected.sourceType,
      position,
      playing,
      reply,
    };
  }

  private projectedPosition(): number {
    const { position, playing, at } = this.expected;

    if (!playing) return Math.max(0, position);

    const elapsed = Math.max(
      0,
      (this.clock.now() - at) / 1000,
    );

    return Math.max(0, position + elapsed);
  }

  private messageTime(sentAt: number): number {
    const now = this.clock.now();

    return Math.max(
      sentAt,
      now - MAX_LATENCY_COMPENSATION_S * 1000,
    );
  }

  private acceptLocal(): boolean {
    if (!this.syncCapable || !this.expected.url) {
      return false;
    }

    if (performance.now() < this.suppressUntil) {
      return false;
    }

    this.leaderId = this.userId;
    return true;
  }

  private commit(
    position: number,
    playing: boolean,
  ): void {
    this.expected = {
      ...this.expected,
      position,
      playing,
      at: this.clock.now(),
    };

    this.persistExpected();
  }

  private persistExpected(): void {
    this.hooks.persist({
      video_url: this.expected.url,
      source_type: this.expected.sourceType,
      is_playing: this.expected.playing,
      position_seconds: this.expected.position,
      ...this.iptvSelection,
    });
  }

  private suppress(): void {
    this.suppressUntil =
      performance.now() + SUPPRESS_MS;
  }

  private send(payload: SyncPayload): void {
    this.channel.send({
      ...payload,
      by: this.userId,
      sentAt: this.clock.now(),
    } as SyncMessage);
  }
}
