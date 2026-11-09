import type { SupabaseClient } from '@supabase/supabase-js';
import type { PersistPayload, RoomStateRow } from './types';

const COLUMNS = 'room_id, video_url, source_type, is_playing, position_seconds, updated_by, updated_at';

export async function fetchRoomState(supabase: SupabaseClient, roomId: string): Promise<RoomStateRow | null> {
  const { data, error } = await supabase.from('room_state').select(COLUMNS).eq('room_id', roomId).maybeSingle();
  if (error) throw error;
  return (data as RoomStateRow | null) ?? null;
}

export async function saveRoomState(supabase: SupabaseClient, roomId: string, payload: PersistPayload): Promise<void> {
  const { error } = await supabase
    .from('room_state')
    .upsert({ room_id: roomId, ...payload, position_seconds: Math.max(0, payload.position_seconds) }, { onConflict: 'room_id' });
  if (error) throw error;
}

export async function fetchServerTime(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc('server_time');
  if (error) throw error;
  const ms = Date.parse(String(data));
  if (!Number.isFinite(ms)) throw new Error('Geçersiz sunucu saati');
  return ms;
}
