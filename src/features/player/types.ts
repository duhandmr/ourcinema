export type SourceKind = 'file' | 'hls' | 'youtube' | 'vimeo' | 'dailymotion' | 'twitch';

export interface VideoSource {
  kind: SourceKind;
  /** Normalize edilmiş, paylaşılan bağlantı */
  url: string;
  /** YouTube video kimliği */
  videoId?: string;
  /** Yalnızca gömülü (kontrol API'si olmayan) oynatıcılar için iframe adresi */
  embedUrl?: string;
  /** Oynatıcı programatik olarak kontrol edilebiliyor mu (tam senkronizasyon) */
  syncCapable: boolean;
  platformLabel: string;
}

export type DetectFailureReason = 'empty' | 'invalid' | 'insecure' | 'unsupported_platform' | 'unknown';

export interface DetectFailure {
  ok: false;
  reason: DetectFailureReason;
  message: string;
  /** Kaynak sitede açmak için bağlantı */
  url?: string;
  platform?: string;
}

export type DetectResult = { ok: true; source: VideoSource } | DetectFailure;

export class AutoplayBlockedError extends Error {
  constructor() {
    super('Tarayıcı otomatik oynatmayı engelledi.');
    this.name = 'AutoplayBlockedError';
  }
}

/** Tüm oynatıcıların senkronizasyon katmanına sunduğu ortak arayüz. */
export interface PlayerController {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  getCurrentTime(): number;
  isPaused(): boolean;
}

export interface PlayerCallbacks {
  onReady(controller: PlayerController): void;
  onPlay(position: number): void;
  onPause(position: number): void;
  onSeek(position: number): void;
  onError(message: string): void;
}
