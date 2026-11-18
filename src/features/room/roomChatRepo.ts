import type { SupabaseClient } from '@supabase/supabase-js';
import type { RoomChatMessage } from '../realtime/RoomChannel';

interface ChatRow {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
}

function fromRow(row: ChatRow): RoomChatMessage {
  return {
    id: row.id,
    userId: row.user_id,
    text: row.content,
    sentAt: Date.parse(row.created_at),
  };
}

export async function fetchRecentRoomChat(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomChatMessage[]> {
  const { data, error } = await supabase
    .from('room_chat_messages')
    .select('id, user_id, content, created_at')
    .eq('room_id', roomId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;
  return ((data ?? []) as ChatRow[]).map(fromRow).reverse();
}

export async function saveRoomChatMessage(
  supabase: SupabaseClient,
  roomId: string,
  content: string,
): Promise<RoomChatMessage> {
  const { data, error } = await supabase
    .from('room_chat_messages')
    .insert({ room_id: roomId, content })
    .select('id, user_id, content, created_at')
    .single();

  if (error) throw error;
  return fromRow(data as ChatRow);
}
