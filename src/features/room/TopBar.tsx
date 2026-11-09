import { Brand } from '../../components/Brand';
import type { RoomMember } from './useRoom';

interface Props {
  members: RoomMember[];
  onlineIds: string[];
  onSignOut: () => void;
}

export function TopBar({ members, onlineIds, onSignOut }: Props) {
  const onlineCount = members.filter((m) => onlineIds.includes(m.userId)).length;
  return (
    <header className="sticky top-0 z-20 border-b border-white/5 bg-ink-950/80 backdrop-blur-xl" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:h-16 sm:px-6">
        <Brand />
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="flex items-center gap-2 rounded-full border border-white/5 bg-ink-800/80 px-3 py-1.5" aria-label={`${onlineCount} / ${members.length} çevrimiçi`}>
            <div className="flex -space-x-1">
              {members.map((m) => (
                <span
                  key={m.userId}
                  className={`h-2.5 w-2.5 rounded-full ring-2 ring-ink-800 ${onlineIds.includes(m.userId) ? 'bg-online' : 'bg-mist-500/50'}`}
                />
              ))}
            </div>
            <span className="text-xs font-medium text-mist-300">
              {onlineCount}/{members.length} çevrimiçi
            </span>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-mist-500 transition hover:bg-white/5 hover:text-mist-100"
          >
            Çıkış
          </button>
        </div>
      </div>
    </header>
  );
}
