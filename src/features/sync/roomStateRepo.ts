import type { SupabaseClient } from '@supabase/supabase-js';
import type { PersistPayload, RoomStateRow } from './types';

const COLUMNS = 'room_id, video_url, source_type, is_playing, position_seconds, updated_by, updated_at, iptv_channel_id, iptv_content_type, iptv_series_id, iptv_episode_id';
const LEGACY_COLUMNS = 'room_id, video_url, source_type, is_playing, position_seconds, updated_by, updated_at';

function missingIptvColumns(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    /column .*iptv_(channel_id|content_type|series_id|episode_id)/i.test(error.message ?? '')
  );
}

export async function fetchRoomState(supabase: SupabaseClient, roomId: string): Promise<RoomStateRow | null> {
  const result = await supabase.from('room_state').select(COLUMNS).eq('room_id', roomId).maybeSingle();
  if (!result.error) return (result.data as RoomStateRow | null) ?? null;
  if (!missingIptvColumns(result.error)) throw result.error;

  // Keep existing projects usable while the additive persistence migration is pending.
  const legacy = await supabase.from('room_state').select(LEGACY_COLUMNS).eq('room_id', roomId).maybeSingle();
  if (legacy.error) throw legacy.error;
  if (!legacy.data) return null;
  return {
    ...(legacy.data as Omit<RoomStateRow, 'iptv_channel_id' | 'iptv_content_type' | 'iptv_series_id' | 'iptv_episode_id'>),
    iptv_channel_id: null,
    iptv_content_type: null,
    iptv_series_id: null,
    iptv_episode_id: null,
  };
}

export async function saveRoomState(supabase: SupabaseClient, roomId: string, payload: PersistPayload): Promise<void> {
  const { error } = await supabase
    .from('room_state')
    .upsert({ room_id: roomId, ...payload, position_seconds: Math.max(0, payload.position_seconds) }, { onConflict: 'room_id' });
  if (!error) return;
  if (!missingIptvColumns(error)) throw error;

  const { error: legacyError } = await supabase.from('room_state').upsert({
    room_id: roomId,
    video_url: payload.video_url,
    source_type: payload.source_type,
    is_playing: payload.is_playing,
    position_seconds: Math.max(0, payload.position_seconds),
  }, { onConflict: 'room_id' });
  if (legacyError) throw legacyError;
}

export async function fetchServerTime(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc('server_time');
  if (error) throw error;
  const ms = Date.parse(String(data));
  if (!Number.isFinite(ms)) throw new Error('Geçersiz sunucu saati');
  return ms;
}
