
import type { SourceKind } from '../player/types';

export interface RoomStateRow {
  room_id: string;
  video_url: string | null;
  source_type: SourceKind | null;
  is_playing: boolean;
  position_seconds: number;
  updated_by: string | null;
  updated_at: string;
  iptv_channel_id: string | null;
  iptv_content_type: 'live' | 'movie' | 'series' | null;
  iptv_series_id: string | null;
  iptv_episode_id: string | null;
}

export interface PersistPayload {
  video_url: string | null;
  source_type: SourceKind | null;
  is_playing: boolean;
  position_seconds: number;
  iptv_channel_id: string | null;
  iptv_content_type: 'live' | 'movie' | 'series' | null;
  iptv_series_id: string | null;
  iptv_episode_id: string | null;
}

/** Realtime broadcast ile gönderilen senkronizasyon mesajları. */
export type SyncPayload =
  | { type: 'load'; url: string; sourceType: SourceKind | null }
  | { type: 'iptv_load'; channelId: string; contentType: 'live' | 'movie' | 'series' }
  | { type: 'iptv_play'; position?: number }
  | { type: 'iptv_pause'; position?: number }
  | { type: 'iptv_seek'; position: number; playing: boolean }
  | { type: 'iptv_state'; playing: boolean; position?: number }
  | {
      type: 'iptv_episode_load';
      seriesId: string;
      episodeId: string;
    }
  | { type: 'play'; url: string; sourceType: SourceKind | null; position: number }
  | { type: 'pause'; url: string; sourceType: SourceKind | null; position: number }
  | { type: 'seek'; url: string; sourceType: SourceKind | null; position: number; playing: boolean }
  | { type: 'state'; url: string; sourceType: SourceKind | null; position: number; playing: boolean; reply: boolean }
  | { type: 'request_state' };

export type SyncMessage = SyncPayload & {
  by: string;
  sentAt: number;
};

const SOURCE_KINDS = new Set([
  'file',
  'hls',
  'mpegts',
  'youtube',
  'vimeo',
  'dailymotion',
  'twitch',
]);

function isPosition(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v >= 0 &&
    v < 360000
  );
}

function isNumericId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d+$/.test(value) &&
    value.length <= 64
  );
}

/** Gelen mesajları doğrular. */
export function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== 'object') return false;

  const m = value as Record<string, unknown>;

  if (
    typeof m.by !== 'string' ||
    typeof m.sentAt !== 'number' ||
    !Number.isFinite(m.sentAt)
  ) {
    return false;
  }

  if (m.type === 'request_state') return true;

  // Normal IPTV kanalı: URL veya kullanıcı bilgisi gönderilmez.
  if (m.type === 'iptv_load') {
    return (
      typeof m.channelId === 'string' &&
      m.channelId.trim().length > 0 &&
      m.channelId.length <= 256 &&
      (m.contentType === 'live' || m.contentType === 'movie' || m.contentType === 'series')
    );
  }

  if (m.type === 'iptv_play' || m.type === 'iptv_pause') {
    return m.position === undefined || isPosition(m.position);
  }
  if (m.type === 'iptv_seek') {
    return isPosition(m.position) && typeof m.playing === 'boolean';
  }
  if (m.type === 'iptv_state') {
    return typeof m.playing === 'boolean' &&
      (m.position === undefined || isPosition(m.position));
  }

  // Dizi bölümü: yalnızca sayısal kimlikler gönderilir.
  if (m.type === 'iptv_episode_load') {
    return (
      isNumericId(m.seriesId) &&
      isNumericId(m.episodeId)
    );
  }

  if (
    typeof m.url !== 'string' ||
    m.url.length > 2048 ||
    !/^https:\/\//i.test(m.url)
  ) {
    return false;
  }

  if (
    m.sourceType !== null &&
    !(
      typeof m.sourceType === 'string' &&
      SOURCE_KINDS.has(m.sourceType)
    )
  ) {
    return false;
  }

  switch (m.type) {
    case 'load':
      return true;

    case 'play':
    case 'pause':
      return isPosition(m.position);

    case 'seek':
      return (
        isPosition(m.position) &&
        typeof m.playing === 'boolean'
      );

    case 'state':
      return (
        isPosition(m.position) &&
        typeof m.playing === 'boolean' &&
        typeof m.reply === 'boolean'
      );

    default:
      return false;
  }
}
