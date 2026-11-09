import { AutoplayBlockedError, type PlayerController, type SourceKind } from '../player/types';
import type { RoomChannel } from '../realtime/RoomChannel';
import type { ServerClock } from './serverClock';
import type { PersistPayload, RoomStateRow, SyncMessage, SyncPayload } from './types';

/** Konum farkı bu değerden büyükse anında sarılır (komutlarda). */
const SEEK_TOLERANCE = 0.75;
/** Periyodik eşitlemede izin verilen kayma. */
const DRIFT_TOLERANCE = 1.5;
/** Uzaktan uygulanan komutun yarattığı yerel olayları yok sayma süresi. */
const SUPPRESS_MS = 1200;
/** Lider (son komutu veren) oynatırken konum yayını aralığı. */
const HEARTBEAT_MS = 4000;
/** Ağ gecikmesi telafisinin üst sınırı. */
const MAX_LATENCY_COMPENSATION_S = 5;

export type ActivityKind = 'play' | 'pause' | 'seek' | 'load';

export interface SyncEngineHooks {
  onRemoteLoad(url: string, sourceType: SourceKind | null, byUserId: string | null): void;
  onActivity(kind: ActivityKind, byUserId: string, position: number): void;
  onNeedsGesture(needed: boolean): void;
  persist(state: PersistPayload): void;
}

interface Expected {
  url: string | null;
  sourceType: SourceKind | null;
  position: number;
  playing: boolean;
  /** position değerinin geçerli olduğu sunucu zamanı (ms) */
  at: number;
}

/**
 * Oynatma senkronizasyonunun kalbi. React'tan bağımsızdır.
 * - Yerel kullanıcı olaylarını yayınlar ve veritabanına kaydeder.
 * - Uzak komutları gecikme telafisiyle uygular.
 * - Yankı döngülerini (uzak komutun tetiklediği yerel olay) bastırır.
 */
export class SyncEngine {
  private controller: PlayerController | null = null;
  private syncCapable = false;
  private suppressUntil = 0;
  private leaderId: string | null = null;
  private expected: Expected = { url: null, sourceType: null, position: 0, playing: false, at: 0 };
  private heartbeatTimer: number | undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly userId: string,
    private readonly channel: RoomChannel,
    private readonly clock: ServerClock,
    private readonly hooks: SyncEngineHooks,
  ) {}

  start(): void {
    this.unsubscribe = this.channel.onMessage((m) => this.handleRemote(m));
    this.heartbeatTimer = window.setInterval(() => this.tick(), HEARTBEAT_MS);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.controller = null;
  }

  /** Veritabanındaki kalıcı durumu uygular (ilk giriş / yeniden bağlanma). */
  hydrate(row: RoomStateRow, tolerance = SEEK_TOLERANCE): void {
    if (!row.video_url) return;
    const at = Date.parse(row.updated_at);
    this.leaderId = row.updated_by;
    this.adopt(
      {
        url: row.video_url,
        sourceType: row.source_type,
        position: row.position_seconds,
        playing: row.is_playing,
        at: Number.isFinite(at) ? at : this.clock.now(),
      },
      null,
      tolerance,
    );
  }

  /** Karşı taraftan anlık durumu ister (katılma, yeniden bağlanma, sekmeye dönüş). */
  requestState(): void {
    this.send({ type: 'request_state' });
  }

  attach(controller: PlayerController | null, syncCapable: boolean): void {
    this.controller = controller;
    this.syncCapable = Boolean(controller) && syncCapable;
    if (this.syncCapable) this.applyExpected(SEEK_TOLERANCE);
  }

  detach(): void {
    this.controller = null;
    this.syncCapable = false;
  }

  // ------------------------------------------------------------------ yerel

  loadVideo(url: string, sourceType: SourceKind): void {
    this.leaderId = this.userId;
    this.expected = { url, sourceType, position: 0, playing: false, at: this.clock.now() };
    this.detach();
    this.hooks.onNeedsGesture(false);
    this.send({ type: 'load', url, sourceType });
    this.persistExpected();
  }

  /** @returns olay kullanıcıdan geldiyse true */
  localPlay(position: number): boolean {
    if (!this.acceptLocal()) return false;
    this.hooks.onNeedsGesture(false);
    this.commit(position, true);
    this.send({ type: 'play', url: this.expected.url as string, sourceType: this.expected.sourceType, position });
    return true;
  }

  localPause(position: number): boolean {
    if (!this.acceptLocal()) return false;
    this.commit(position, false);
    this.send({ type: 'pause', url: this.expected.url as string, sourceType: this.expected.sourceType, position });
    return true;
  }

  localSeek(position: number): boolean {
    if (!this.acceptLocal()) return false;
    const playing = this.controller ? !this.controller.isPaused() : this.expected.playing;
    this.commit(position, playing);
    this.send({ type: 'seek', url: this.expected.url as string, sourceType: this.expected.sourceType, position, playing });
    return true;
  }

  /** Otomatik oynatma engellendiğinde kullanıcının dokunuşuyla başlatma. */
  async resumeFromGesture(): Promise<void> {
    const c = this.controller;
    if (!c) return;
    const target = this.projectedPosition();
    this.suppress();
    if (Math.abs(c.getCurrentTime() - target) > SEEK_TOLERANCE) c.seek(target);
    try {
      await c.play();
      this.hooks.onNeedsGesture(false);
    } catch (err) {
      this.hooks.onNeedsGesture(err instanceof AutoplayBlockedError);
    }
  }

  // ------------------------------------------------------------------ uzak

  private handleRemote(msg: SyncMessage): void {
    if (msg.by === this.userId) return;

    switch (msg.type) {
      case 'request_state':
        if (this.expected.url) this.send(this.snapshot(true));
        return;

      case 'load':
        this.leaderId = msg.by;
        this.hooks.onActivity('load', msg.by, 0);
        this.adopt({ url: msg.url, sourceType: msg.sourceType, position: 0, playing: false, at: msg.sentAt }, msg.by, SEEK_TOLERANCE, true);
        return;

      case 'play':
      case 'pause':
      case 'seek': {
        this.leaderId = msg.by;
        const playing = msg.type === 'play' ? true : msg.type === 'pause' ? false : msg.playing;
        this.hooks.onActivity(msg.type, msg.by, msg.position);
        this.adopt({ url: msg.url, sourceType: msg.sourceType, position: msg.position, playing, at: this.messageTime(msg.sentAt) }, msg.by, SEEK_TOLERANCE);
        return;
      }

      case 'state': {
        // Periyodik yayınlarda yalnızca lideri takip et; istek yanıtlarını her zaman uygula.
        if (!msg.reply && this.leaderId === this.userId) return;
        if (msg.reply && this.leaderId === this.userId && this.controller && this.syncCapable && msg.url === this.expected.url) return;
        if (!msg.reply) this.leaderId = msg.by;
        this.adopt(
          { url: msg.url, sourceType: msg.sourceType, position: msg.position, playing: msg.playing, at: this.messageTime(msg.sentAt) },
          msg.by,
          DRIFT_TOLERANCE,
        );
        return;
      }
    }
  }

  private adopt(next: Expected, by: string | null, tolerance: number, forceReload = false): void {
    const urlChanged = forceReload || next.url !== this.expected.url;
    this.expected = next;
    if (urlChanged && next.url) {
      this.detach();
      this.hooks.onNeedsGesture(false);
      this.hooks.onRemoteLoad(next.url, next.sourceType, by);
      return; // yeni oynatıcı hazır olunca attach() durumu uygular
    }
    this.applyExpected(tolerance);
  }

  private applyExpected(tolerance: number): void {
    const c = this.controller;
    if (!c || !this.syncCapable || !this.expected.url) return;

    const target = this.projectedPosition();
    const paused = c.isPaused();
    const needSeek = Math.abs(c.getCurrentTime() - target) > tolerance;
    const needPlay = this.expected.playing && paused;
    const needPause = !this.expected.playing && !paused;

    if (!this.expected.playing) this.hooks.onNeedsGesture(false);
    if (!needSeek && !needPlay && !needPause) return;

    this.suppress();
    if (needSeek) c.seek(target);
    if (needPause) c.pause();
    if (needPlay) {
      c.play()
        .then(() => this.hooks.onNeedsGesture(false))
        .catch((err: unknown) => {
          if (err instanceof AutoplayBlockedError) this.hooks.onNeedsGesture(true);
        });
    }
  }

  // ------------------------------------------------------------------ yardımcılar

  private tick(): void {
    const c = this.controller;
    if (!c || !this.syncCapable || !this.expected.url) return;
    if (this.leaderId !== this.userId || c.isPaused()) return;
    this.expected = { ...this.expected, position: c.getCurrentTime(), playing: true, at: this.clock.now() };
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
    const elapsed = Math.max(0, (this.clock.now() - at) / 1000);
    return Math.max(0, position + elapsed);
  }

  /** Mesaj zamanını, aşırı gecikme telafisini önleyecek şekilde sınırlar. */
  private messageTime(sentAt: number): number {
    const now = this.clock.now();
    return Math.max(sentAt, now - MAX_LATENCY_COMPENSATION_S * 1000);
  }

  private acceptLocal(): boolean {
    if (!this.syncCapable || !this.expected.url) return false;
    if (performance.now() < this.suppressUntil) return false;
    this.leaderId = this.userId;
    return true;
  }

  private commit(position: number, playing: boolean): void {
    this.expected = { ...this.expected, position, playing, at: this.clock.now() };
    this.persistExpected();
  }

  private persistExpected(): void {
    this.hooks.persist({
      video_url: this.expected.url,
      source_type: this.expected.sourceType,
      is_playing: this.expected.playing,
      position_seconds: this.expected.position,
    });
  }

  private suppress(): void {
    this.suppressUntil = performance.now() + SUPPRESS_MS;
  }

  private send(payload: SyncPayload): void {
    this.channel.send({ ...payload, by: this.userId, sentAt: this.clock.now() } as SyncMessage);
  }
}
