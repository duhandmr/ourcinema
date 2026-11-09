import { initials } from '../../utils/format';
import type { RoomMember } from './useRoom';

interface Props {
  members: RoomMember[];
  onlineIds: string[];
  currentUserId: string;
}

export function PresenceBar({ members, onlineIds, currentUserId }: Props) {
  return (
    <ul className="flex flex-wrap items-center gap-2 sm:gap-3" aria-label="Kullanıcı durumları">
      {members.map((m) => {
        const online = onlineIds.includes(m.userId);
        return (
          <li
            key={m.userId}
            className={`flex items-center gap-2.5 rounded-full border px-2 py-1.5 pr-4 transition ${
              online ? 'border-online/20 bg-online/5' : 'border-white/5 bg-ink-800/60'
            }`}
          >
            <span className="relative">
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold ${
                  online ? 'bg-ink-600 text-mist-100' : 'bg-ink-700 text-mist-500'
                }`}
              >
                {initials(m.displayName)}
              </span>
              <span
                className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-ink-900 ${online ? 'bg-online' : 'bg-mist-500/60'}`}
              />
            </span>
            <span className={`text-sm ${online ? 'text-mist-100' : 'text-mist-500'}`}>
              {m.displayName}
              {m.userId === currentUserId && <span className="text-mist-500"> (sen)</span>}
            </span>
            <span className={`text-xs ${online ? 'text-online' : 'text-mist-500'}`}>{online ? 'Çevrimiçi' : 'Çevrimdışı'}</span>
          </li>
        );
      })}
    </ul>
  );
}
