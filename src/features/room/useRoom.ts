import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '../../lib/supabase';
import { fetchRoomState } from '../sync/roomStateRepo';
import type { RoomStateRow } from '../sync/types';

export interface RoomMember {
  userId: string;
  displayName: string;
}

export interface RoomData {
  roomId: string;
  roomName: string;
  members: RoomMember[];
  initialState: RoomStateRow | null;
}

export type RoomLoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: RoomData }
  | { status: 'forbidden' }
  | { status: 'error'; message: string };

type MemberRow = {
  user_id: string;
  profiles: { display_name: string } | { display_name: string }[] | null;
};

function displayNameOf(row: MemberRow): string {
  const p = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return p?.display_name?.trim() || 'Kullanıcı';
}

/** Kullanıcının üyesi olduğu özel odayı yükler. Yetki kontrolü RLS ile sunucudadır. */
export function useRoom(userId: string) {
  const [state, setState] = useState<RoomLoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const supabase = getSupabase();
    setState({ status: 'loading' });

    (async () => {
      const { data: rooms, error: roomError } = await supabase
        .from('rooms')
        .select('id, name')
        .order('created_at', { ascending: true })
        .limit(1);
      if (roomError) throw roomError;
      const room = (rooms as Array<{ id: string; name: string }> | null)?.[0];
      if (!room) {
        if (active) setState({ status: 'forbidden' });
        return;
      }

      const [{ data: members, error: memberError }, initialState] = await Promise.all([
        supabase.from('room_members').select('user_id, profiles(display_name)').eq('room_id', room.id),
        fetchRoomState(supabase, room.id),
      ]);
      if (memberError) throw memberError;

      const list = ((members ?? []) as unknown as MemberRow[])
        .map((m) => ({ userId: m.user_id, displayName: displayNameOf(m) }))
        .sort((a, b) => (a.userId === userId ? -1 : b.userId === userId ? 1 : a.displayName.localeCompare(b.displayName, 'tr')));

      if (!list.some((m) => m.userId === userId)) {
        if (active) setState({ status: 'forbidden' });
        return;
      }

      if (active) setState({ status: 'ready', data: { roomId: room.id, roomName: room.name, members: list, initialState } });
    })().catch((err: unknown) => {
      console.error('[OurCinema] Oda yüklenemedi', err);
      if (active) {
        setState({
          status: 'error',
          message: navigator.onLine
            ? 'Oda bilgileri alınamadı. Lütfen tekrar deneyin.'
            : 'İnternet bağlantısı yok. Bağlandığınızda tekrar deneyin.',
        });
      }
    });

    return () => {
      active = false;
    };
  }, [userId, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}
