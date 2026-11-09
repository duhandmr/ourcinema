import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { isSyncMessage, type SyncMessage } from '../sync/types';

export type ChannelStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

type Listener<T> = (value: T) => void;

/**
 * Oda başına tek bir özel (private) Supabase Realtime kanalı.
 * - broadcast: oynatma komutları
 * - presence: çevrimiçi kullanıcılar
 * Kanala erişim, realtime.messages üzerindeki RLS politikalarıyla sunucuda denetlenir.
 */
export class RoomChannel {
  private channel: RealtimeChannel | null = null;
  private status: ChannelStatus = 'connecting';
  private connectedOnce = false;
  private closed = false;
  private readonly messageListeners = new Set<Listener<SyncMessage>>();
  private readonly presenceListeners = new Set<Listener<string[]>>();
  private readonly statusListeners = new Set<Listener<ChannelStatus>>();

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly roomId: string,
    private readonly userId: string,
  ) {}

  async connect(): Promise<void> {
    try {
      const { data } = await this.supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) await this.supabase.realtime.setAuth(token);
    } catch {
      // Oturum alınamazsa kanal yetkisiz kalır ve hata durumu raporlanır
    }
    if (this.closed) return;

    const channel = this.supabase.channel(`room:${this.roomId}`, {
      config: {
        private: true,
        broadcast: { self: false, ack: false },
        presence: { key: this.userId },
      },
    });

    channel.on('broadcast', { event: 'sync' }, (message) => {
      const payload: unknown = (message as { payload?: unknown }).payload;
      if (isSyncMessage(payload)) this.messageListeners.forEach((l) => l(payload));
    });

    channel.on('presence', { event: 'sync' }, () => {
      const ids = Object.keys(channel.presenceState());
      this.presenceListeners.forEach((l) => l(ids));
    });

    channel.subscribe((status) => {
      if (this.closed) return;
      if (status === 'SUBSCRIBED') {
        this.connectedOnce = true;
        this.setStatus('connected');
        void channel.track({ online_at: new Date().toISOString() }).catch(() => undefined);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this.setStatus(this.connectedOnce ? 'reconnecting' : 'error');
      } else if (status === 'CLOSED') {
        this.setStatus('reconnecting');
      }
    });

    this.channel = channel;
  }

  send(message: SyncMessage): void {
    if (!this.channel || this.closed) return;
    void this.channel.send({ type: 'broadcast', event: 'sync', payload: message }).catch(() => undefined);
  }

  onMessage(listener: Listener<SyncMessage>): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onPresence(listener: Listener<string[]>): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  onStatus(listener: Listener<ChannelStatus>): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  disconnect(): void {
    this.closed = true;
    const channel = this.channel;
    this.channel = null;
    this.messageListeners.clear();
    this.presenceListeners.clear();
    this.statusListeners.clear();
    if (channel) {
      void channel.untrack().catch(() => undefined);
      void this.supabase.removeChannel(channel).catch(() => undefined);
    }
  }

  private setStatus(status: ChannelStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }
}
