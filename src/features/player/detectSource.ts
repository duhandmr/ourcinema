
import type { DetectResult, VideoSource } from './types';
import { iptvApiUrl } from '../iptv/api';

const UNSUPPORTED_PLATFORMS: Array<{ match: RegExp; label: string }> = [
  { match: /(^|\.)netflix\.com$/, label: 'Netflix' },
  { match: /(^|\.)disneyplus\.com$/, label: 'Disney+' },
  { match: /(^|\.)primevideo\.com$/, label: 'Prime Video' },
  { match: /(^|\.)amazon\.[a-z.]+$/, label: 'Amazon' },
  { match: /(^|\.)(max|hbomax)\.com$/, label: 'Max' },
  { match: /(^|\.)blutv\.com(\.tr)?$/, label: 'BluTV' },
  { match: /(^|\.)exxen\.com$/, label: 'Exxen' },
  { match: /(^|\.)gain\.tv$/, label: 'Gain' },
  { match: /(^|\.)tod\.tv$/, label: 'TOD' },
  { match: /(^|\.)tabii\.com$/, label: 'tabii' },
  { match: /(^|\.)puhutv\.com$/, label: 'puhutv' },
  { match: /(^|\.)mubi\.com$/, label: 'MUBI' },
  { match: /(^|\.)hulu\.com$/, label: 'Hulu' },
  { match: /^tv\.apple\.com$/, label: 'Apple TV' },
  { match: /(^|\.)paramountplus\.com$/, label: 'Paramount+' },
  { match: /(^|\.)crunchyroll\.com$/, label: 'Crunchyroll' },
  {
    match: /(^|\.)(instagram|tiktok|facebook|x|twitter)\.com$/,
    label: 'Sosyal medya',
  },
];

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function parentHost(): string {
  return typeof window !== 'undefined' && window.location?.hostname
    ? window.location.hostname
    : 'localhost';
}

function youTubeId(url: URL, host: string): string | null {
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1] ?? '';
    return YT_ID.test(id) ? id : null;
  }

  if (url.pathname === '/watch') {
    const v = url.searchParams.get('v') ?? '';
    return YT_ID.test(v) ? v : null;
  }

  const m = url.pathname.match(
    /^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/,
  );

  return m ? m[2] : null;
}

function ok(source: VideoSource): DetectResult {
  return { ok: true, source };
}

interface DetectOptions {
  forceFile?: boolean;
  iptv?: boolean;
  contentType?: 'live' | 'movie' | 'series';
}

function detectIptvSource(
  url: URL,
  contentType?: 'live' | 'movie' | 'series',
): DetectResult {
  if (!['http:', 'https:'].includes(url.protocol)) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'IPTV bağlantısının protokolü desteklenmiyor.',
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'Kimlik bilgisi içeren yayın adresleri desteklenmiyor.',
    };
  }

  const path = url.pathname.toLowerCase();
  const extension = path.match(/\.([a-z0-9]+)$/)?.[1];
  // Keep the detected media suffix on the proxy URL so VLC can choose its
  // container demuxer (some IPTV URLs expose the container only in the URL).
  const proxyPath = extension
    ? `/api/iptv/stream/source.${extension}`
    : '/api/iptv/stream';
  const proxiedUrl = iptvApiUrl(
    `${proxyPath}?url=${encodeURIComponent(url.toString())}`,
  );

  // İçerik türü belirtilmemişse eski davranışı koru.
  const isLive = contentType
    ? contentType === 'live'
    : true;

  if (extension === 'm3u8') {
    return ok({
      kind: 'hls',
      url: proxiedUrl,
      syncCapable: true,
      platformLabel: 'IPTV HLS yayını',
      isLive,
    });
  }

  if (extension === 'ts') {
    return ok({
      kind: 'mpegts',
      url: proxiedUrl,
      syncCapable: false,
      platformLabel: 'IPTV MPEG-TS yayını',
      isLive,
    });
  }

  // MKV uzantısı da tanınır.
  if (
    ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'mkv'].includes(
      extension ?? '',
    )
  ) {
    return ok({
      kind: 'file',
      url: proxiedUrl,
      playerEngine: 'vlc-wasm',
      syncCapable: true,
      platformLabel: 'IPTV video dosyası',
      isLive: false,
    });
  }

  if (!extension) {
    return ok({
      kind: 'mpegts',
      url: proxiedUrl,
      syncCapable: false,
      platformLabel: 'IPTV yayını',
      isLive,
    });
  }

  return {
    ok: false,
    reason: 'unknown',
    url: url.toString(),
    message: `IPTV yayın uzantısı tanınamadı: .${extension}`,
  };
}

export function detectSource(
  input: string,
  options: DetectOptions = {},
): DetectResult {
  const raw = input.trim();

  if (!raw) {
    return {
      ok: false,
      reason: 'empty',
      message: 'Lütfen bir video bağlantısı yapıştırın.',
    };
  }

  if (raw.length > 2048) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'Bağlantı çok uzun.',
    };
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: 'invalid',
      message:
        'Bu geçerli bir bağlantı değil. https:// ile başlayan tam adresi yapıştırın.',
    };
  }

  if (options.iptv) {
    return detectIptvSource(url, options.contentType);
  }

  if (url.protocol === 'http:') {
    return {
      ok: false,
      reason: 'insecure',
      message:
        'Yalnızca güvenli (https://) bağlantılar desteklenir.',
    };
  }

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'invalid',
      message: 'Yalnızca https:// bağlantıları desteklenir.',
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'invalid',
      message: 'Kullanıcı adı veya şifre içeren bağlantılar desteklenmez.',
    };
  }

  const href = url.toString();
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const path = url.pathname.toLowerCase();

  if (options.forceFile) {
    return ok({
      kind: 'file',
      url: href,
      syncCapable: true,
      platformLabel: 'Video dosyası',
    });
  }

  if (
    [
      'youtube.com',
      'music.youtube.com',
      'youtube-nocookie.com',
      'youtu.be',
    ].includes(host)
  ) {
    const id = youTubeId(url, host);

    if (!id) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'YouTube bağlantısında bir video bulunamadı.',
      };
    }

    return ok({
      kind: 'youtube',
      url: `https://www.youtube.com/watch?v=${id}`,
      videoId: id,
      syncCapable: true,
      platformLabel: 'YouTube',
    });
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    let id: string | undefined;
    let hash: string | undefined;

    if (host === 'player.vimeo.com') {
      const m = url.pathname.match(/^\/video\/(\d+)/);
      id = m?.[1];
      hash = url.searchParams.get('h') ?? undefined;
    } else {
      const m = url.pathname.match(
        /^\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d+)(?:\/([a-z0-9]+))?/i,
      );

      id = m?.[1];
      hash = m?.[2];
    }

    if (!id) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'Vimeo bağlantısında bir video bulunamadı.',
      };
    }

    return ok({
      kind: 'vimeo',
      url: `https://vimeo.com/${id}${hash ? `/${hash}` : ''}`,
      syncCapable: true,
      platformLabel: 'Vimeo',
    });
  }

  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const m =
      host === 'dai.ly'
        ? url.pathname.match(/^\/([a-z0-9]+)/i)
        : url.pathname.match(/^\/(?:embed\/)?video\/([a-z0-9]+)/i);

    if (!m) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'Dailymotion bağlantısında bir video bulunamadı.',
      };
    }

    return ok({
      kind: 'dailymotion',
      url: `https://www.dailymotion.com/video/${m[1]}`,
      embedUrl: `https://www.dailymotion.com/embed/video/${m[1]}`,
      syncCapable: false,
      platformLabel: 'Dailymotion',
    });
  }

  if (host === 'twitch.tv' || host === 'clips.twitch.tv') {
    const parent = encodeURIComponent(parentHost());

    if (host === 'clips.twitch.tv') {
      const slug = url.pathname.split('/')[1];

      if (slug && /^[A-Za-z0-9_-]+$/.test(slug)) {
        return ok({
          kind: 'twitch',
          url: href,
          embedUrl: `https://clips.twitch.tv/embed?clip=${slug}&parent=${parent}`,
          syncCapable: false,
          platformLabel: 'Twitch',
        });
      }
    }

    const vod = url.pathname.match(/^\/videos\/(\d+)/);

    if (vod) {
      return ok({
        kind: 'twitch',
        url: href,
        embedUrl: `https://player.twitch.tv/?video=v${vod[1]}&parent=${parent}&autoplay=false`,
        syncCapable: false,
        platformLabel: 'Twitch',
      });
    }

    const clip = url.pathname.match(
      /^\/[A-Za-z0-9_]+\/clip\/([A-Za-z0-9_-]+)/,
    );

    if (clip) {
      return ok({
        kind: 'twitch',
        url: href,
        embedUrl: `https://clips.twitch.tv/embed?clip=${clip[1]}&parent=${parent}`,
        syncCapable: false,
        platformLabel: 'Twitch',
      });
    }

    const channel = url.pathname.match(/^\/([A-Za-z0-9_]{3,25})\/?$/);

    if (channel) {
      return ok({
        kind: 'twitch',
        url: href,
        embedUrl: `https://player.twitch.tv/?channel=${channel[1]}&parent=${parent}&autoplay=false`,
        syncCapable: false,
        platformLabel: 'Twitch',
      });
    }

    return {
      ok: false,
      reason: 'invalid',
      message: 'Twitch bağlantısında bir yayın, video veya klip bulunamadı.',
    };
  }

  if (/\.m3u8$/.test(path)) {
    return ok({
      kind: 'hls',
      url: href,
      syncCapable: true,
      platformLabel: 'HLS yayını',
    });
  }

  if (/\.ts$/.test(path)) {
    return ok({
      kind: 'mpegts',
      url: href,
      syncCapable: false,
      platformLabel: 'MPEG-TS yayını',
    });
  }

  // Normal video bağlantılarında da MKV uzantısını tanı.
  if (/\.(mp4|m4v|webm|ogv|ogg|mov|mkv)$/.test(path)) {
    return ok({
      kind: 'file',
      url: href,
      syncCapable: true,
      platformLabel: 'Video dosyası',
    });
  }

  const blocked = UNSUPPORTED_PLATFORMS.find((p) => p.match.test(host));

  if (blocked) {
    return {
      ok: false,
      reason: 'unsupported_platform',
      platform: blocked.label,
      url: href,
      message: `${blocked.label} videosu doğrudan oynatılamıyor.`,
    };
  }

  return {
    ok: false,
    reason: 'unknown',
    url: href,
    message:
      'Bu bağlantı doğrudan bir video dosyası ya da desteklenen bir platform değil.',
  };
}
