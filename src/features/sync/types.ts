import type { SourceKind } from '../player/types';

export interface RoomStateRow {
  room_id: string;
  video_url: string | null;
  source_type: SourceKind | null;
  is_playing: boolean;
  position_seconds: number;
  updated_by: string | null;
  updated_at: string;
}

export interface PersistPayload {
  video_url: string | null;
  source_type: SourceKind | null;
  is_playing: boolean;
  position_seconds: number;
}

/** Realtime broadcast ile gönderilen senkronizasyon mesajları. */
export type SyncPayload =
  | { type: 'load'; url: string; sourceType: SourceKind | null }
  | { type: 'play'; url: string; sourceType: SourceKind | null; position: number }
  | { type: 'pause'; url: string; sourceType: SourceKind | null; position: number }
  | { type: 'seek'; url: string; sourceType: SourceKind | null; position: number; playing: boolean }
  | { type: 'state'; url: string; sourceType: SourceKind | null; position: number; playing: boolean; reply: boolean }
  | { type: 'request_state' };

export type SyncMessage = SyncPayload & { by: string; sentAt: number };

const SOURCE_KINDS = new Set(['file', 'hls', 'youtube', 'vimeo', 'dailymotion', 'twitch']);

function isPosition(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 360000;
}

/** Gelen mesajları doğrular (yalnızca oda üyeleri gönderebilir ama yine de güvenmeyiz). */
export function isSyncMessage(value: unknown): value is SyncMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  if (typeof m.by !== 'string' || typeof m.sentAt !== 'number' || !Number.isFinite(m.sentAt)) return false;
  if (m.type === 'request_state') return true;
  if (typeof m.url !== 'string' || m.url.length > 2048 || !/^https:\/\//i.test(m.url)) return false;
  if (m.sourceType !== null && !(typeof m.sourceType === 'string' && SOURCE_KINDS.has(m.sourceType))) return false;
  switch (m.type) {
    case 'load':
      return true;
    case 'play':
    case 'pause':
      return isPosition(m.position);
    case 'seek':
      return isPosition(m.position) && typeof m.playing === 'boolean';
    case 'state':
      return isPosition(m.position) && typeof m.playing === 'boolean' && typeof m.reply === 'boolean';
    default:
      return false;
  }
}
