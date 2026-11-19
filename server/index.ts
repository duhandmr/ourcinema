
import express, { type Request, type Response as ExpressResponse } from 'express';
import { createClient } from '@supabase/supabase-js';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';

export const app = express();

const MAX_PLAYLIST_SIZE = 100 * 1024 * 1024;
const MAX_API_RESPONSE_SIZE = 25 * 1024 * 1024;
const MAX_SUBTITLE_SIZE = 5 * 1024 * 1024;
const MAX_HLS_PLAYLIST_SIZE = 5 * 1024 * 1024;
const REQUEST_TIMEOUT = 30000;
const CACHE_DURATION = 15 * 60 * 1000;
const XTREAM_PAGE_SIZE_DEFAULT = 50;
const XTREAM_PAGE_SIZE_MAX = 100;
const XTREAM_CACHE_MAX_ENTRIES = 30;

type ContentType = 'live' | 'movie' | 'series';

interface IptvItem {
    id: string;
    name: string;
    url: string;
    logo: string | null;
    group: string;
    type: ContentType;
}

interface XtreamCredentials {
    serverUrl: string;
    username: string;
    password: string;
}

interface XtreamCachedItem {
    id: string;
    name: string;
    url: string;
    logo: string | null;
    group: string;
    categoryId: string | null;
    type: ContentType;
    cover?: string | null;
    plot?: string | null;
    year?: string | number | null;
    rating?: string | number | null;
}

interface XtreamSubtitleTrack {
    label: string;
    language: string;
    url: string;
    format: 'srt' | 'vtt';
}

interface XtreamCacheEntry {
    expiresAt: number;
    items: XtreamCachedItem[];
}

let catalog: IptvItem[] = [];
let catalogLoadedAt: number | null = null;
let isLoading = false;

let xtreamCredentials: XtreamCredentials | null = null;
let xtreamConnectedAt: number | null = null;
let xtreamEnvironmentError: string | null = null;

// Xtream katalogları backend belleğinde tutulur.
const xtreamItemsCache = new Map<string, XtreamCacheEntry>();
const xtreamSearchIndexCache = new Map<string, XtreamCacheEntry>();

const supabaseUrl = process.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY?.trim();
const supabaseAuthClient = supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false,
        },
    })
    : null;
const verifiedAccessTokens = new Map<string, { userId: string; expiresAt: number }>();
const pendingAccessTokenChecks = new Map<string, Promise<string | null>>();

app.use(express.json({ limit: '10kb' }));

const allowedIptvOrigins = (process.env.IPTV_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowedIptvOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
        res.append('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
        if (!origin || !allowedIptvOrigins.includes(origin)) {
            return res.sendStatus(403);
        }

        return res.sendStatus(204);
    }

    next();
});

function jwtExpirationTime(token: string): number | null {
    try {
        const payload = token.split('.')[1];
        if (!payload) return null;
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
            exp?: unknown;
        };
        return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    } catch {
        return null;
    }
}

async function verifySupabaseAccessToken(token: string): Promise<string | null> {
    const now = Date.now();
    const cached = verifiedAccessTokens.get(token);
    if (cached && cached.expiresAt > now) return cached.userId;

    const pending = pendingAccessTokenChecks.get(token);
    if (pending) return pending;
    if (!supabaseAuthClient) return null;

    const check = (async () => {
        const { data, error } = await supabaseAuthClient.auth.getUser(token);
        if (error || !data.user) return null;

        const tokenExpiry = jwtExpirationTime(token);
        const expiresAt = Math.min(tokenExpiry ?? now + 30_000, now + 30_000);
        verifiedAccessTokens.set(token, { userId: data.user.id, expiresAt });
        if (verifiedAccessTokens.size > 1000) {
            for (const [cachedToken, value] of verifiedAccessTokens) {
                if (value.expiresAt <= now) verifiedAccessTokens.delete(cachedToken);
            }
            while (verifiedAccessTokens.size > 1000) {
                const oldestToken = verifiedAccessTokens.keys().next().value;
                if (!oldestToken) break;
                verifiedAccessTokens.delete(oldestToken);
            }
        }
        return data.user.id;
    })();

    pendingAccessTokenChecks.set(token, check);
    try {
        return await check;
    } finally {
        pendingAccessTokenChecks.delete(token);
    }
}

interface PlaybackTokenPayload {
    sub: string;
    hosts: string[];
    exp: number;
}

function signPlaybackToken(payload: PlaybackTokenPayload): string {
    const secret = process.env.IPTV_PLAYBACK_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) {
        throw new Error('IPTV_PLAYBACK_SECRET en az 32 bayt olmalıdır.');
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
    return `${encodedPayload}.${signature}`;
}

function verifyPlaybackToken(token: string): PlaybackTokenPayload | null {
    const secret = process.env.IPTV_PLAYBACK_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) return null;

    const [encodedPayload, signature, extra] = token.split('.');
    if (!encodedPayload || !signature || extra) return null;

    const expected = createHmac('sha256', secret).update(encodedPayload).digest();
    let received: Buffer;
    try {
        received = Buffer.from(signature, 'base64url');
    } catch {
        return null;
    }
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

    try {
        const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as PlaybackTokenPayload;
        if (
            typeof payload.sub !== 'string' ||
            !Array.isArray(payload.hosts) ||
            payload.hosts.some((host) => typeof host !== 'string') ||
            typeof payload.exp !== 'number' ||
            payload.exp <= Math.floor(Date.now() / 1000)
        ) return null;
        return payload;
    } catch {
        return null;
    }
}

// Every IPTV endpoint requires a valid Supabase session. Media elements cannot
// attach headers, so stream requests may carry their short-lived session JWT in
// the query string; all other endpoints accept it only in Authorization.
app.use('/api/iptv', async (req, res, next) => {
    const routePath = `${req.baseUrl}${req.path}`;
    const isStreamRequest = routePath === '/api/iptv/stream' ||
        routePath.startsWith('/api/iptv/stream/');
    if (isStreamRequest && typeof req.query.playback_token === 'string') {
        const payload = verifyPlaybackToken(req.query.playback_token);
        const rawUrl = req.query.url;
        let requestedHost = '';
        try {
            if (typeof rawUrl === 'string') requestedHost = new URL(rawUrl).hostname.toLowerCase();
        } catch {
            requestedHost = '';
        }
        if (payload && requestedHost && payload.hosts.includes(requestedHost)) {
            res.locals.iptvUserId = payload.sub;
            return next();
        }
        return res.status(401).json({ error: 'Oynatma izni geçersiz veya süresi dolmuş.' });
    }

    const authorization = req.header('authorization') || '';
    const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1] || '';

    if (!token) {
        return res.status(401).json({ error: 'IPTV için oturum açmanız gerekiyor.' });
    }

    try {
        const userId = await verifySupabaseAccessToken(token);
        if (!userId) {
            return res.status(401).json({ error: 'Oturum geçersiz veya süresi dolmuş.' });
        }
        res.locals.iptvUserId = userId;
        return next();
    } catch {
        return res.status(503).json({ error: 'Oturum doğrulama hizmetine ulaşılamıyor.' });
    }
});

app.post('/api/iptv/playback-token', async (req, res) => {
    try {
        const credentials = getActiveCredentials();
        const rawUrl = req.body?.url;
        if (typeof rawUrl !== 'string' || rawUrl.length > 4096) {
            return res.status(400).json({ error: 'Geçersiz yayın adresi.' });
        }

        const target = new URL(rawUrl);
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
            return res.status(400).json({ error: 'Yayın adresi desteklenmiyor.' });
        }

        const providerHost = new URL(credentials.serverUrl).hostname.toLowerCase();
        const allowedHosts = (process.env.IPTV_STREAM_HOSTS || '')
            .split(',')
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean);
        const hosts = Array.from(new Set([providerHost, ...allowedHosts]));
        if (!hosts.includes(target.hostname.toLowerCase())) {
            return res.status(403).json({ error: 'Bu yayın sunucusuna izin verilmiyor.' });
        }

        await validateServerUrl(`${target.protocol}//${target.host}/`);
        const token = signPlaybackToken({
            sub: String(res.locals.iptvUserId),
            hosts,
            exp: Math.floor(Date.now() / 1000) + 60 * 60,
        });
        return res.json({ token, expiresIn: 3600 });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Oynatma izni üretilemedi.';
        console.error('[IPTV Playback Token Error]', message);
        return res.status(503).json({ error: message });
    }
});

// --------------------------------------------------
// IP güvenlik kontrolleri
// --------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
    const parts = ip.split('.').map(Number);

    if (
        parts.length !== 4 ||
        parts.some(
            (part) =>
                !Number.isInteger(part) ||
                part < 0 ||
                part > 255,
        )
    ) {
        return true;
    }

    const [a, b, c] = parts;

    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 0 || b === 168)) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 203 && b === 0 && c === 113)
    );
}

function isGlobalIPv6(ip: string): boolean {
    const firstPart = parseInt(ip.split(':')[0] || '0', 16);
    return firstPart >= 0x2000 && firstPart <= 0x3fff;
}

async function validateServerUrl(value: string): Promise<URL> {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        throw new Error('Geçersiz sunucu adresi.');
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Yalnızca HTTP ve HTTPS adresleri desteklenir.');
    }

    if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
    ) {
        throw new Error('Geçersiz sunucu adresi.');
    }

    const hostname = url.hostname.toLowerCase();

    if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local')
    ) {
        throw new Error('Bu sunucu adresine izin verilmiyor.');
    }

    const ipVersion = isIP(hostname);

    if (ipVersion === 4 && isPrivateIPv4(hostname)) {
        throw new Error('Özel IP adreslerine izin verilmiyor.');
    }

    if (ipVersion === 6 && !isGlobalIPv6(hostname)) {
        throw new Error('Bu IPv6 adresine izin verilmiyor.');
    }

    if (!ipVersion) {
        const addresses = await lookup(hostname, { all: true });

        if (addresses.length === 0) {
            throw new Error('Sunucu adresi çözümlenemedi.');
        }

        for (const address of addresses) {
            if (
                (address.family === 4 && isPrivateIPv4(address.address)) ||
                (address.family === 6 && !isGlobalIPv6(address.address))
            ) {
                throw new Error('Sunucu adresi güvenli değil.');
            }
        }
    }

    return url;
}

// --------------------------------------------------
// İstek doğrulama
// --------------------------------------------------

function getCredentials(body: unknown): XtreamCredentials {
    if (!body || typeof body !== 'object') {
        throw new Error('Geçersiz istek.');
    }

    const data = body as Record<string, unknown>;
    const { serverUrl, username, password } = data;

    if (
        typeof serverUrl !== 'string' ||
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        !serverUrl.trim() ||
        !username.trim() ||
        !password
    ) {
        throw new Error('Sunucu adresi, kullanıcı adı ve şifre gerekli.');
    }

    if (
        serverUrl.length > 500 ||
        username.length > 256 ||
        password.length > 256
    ) {
        throw new Error('Giriş bilgileri çok uzun.');
    }

    return {
        serverUrl: serverUrl.trim(),
        username: username.trim(),
        password,
    };
}

function getActiveCredentials(): XtreamCredentials {
    const environmentCredentials = getEnvironmentCredentials();

    if (
        !xtreamCredentials ||
        !xtreamConnectedAt ||
        Date.now() - xtreamConnectedAt > CACHE_DURATION
    ) {
        // Server-configured credentials can restore the session without
        // asking the browser to persist or resend the IPTV password.
        if (environmentCredentials) {
            xtreamCredentials = environmentCredentials;
            xtreamConnectedAt = Date.now();
            xtreamItemsCache.clear();
            return xtreamCredentials;
        }

        xtreamCredentials = null;
        xtreamConnectedAt = null;
        xtreamItemsCache.clear();

        throw new Error(
            'Xtream bağlantısı bulunamadı veya süresi doldu. Yeniden bağlanın.',
        );
    }

    return xtreamCredentials;
}

function getEnvironmentCredentials(): XtreamCredentials | null {
    const serverUrl = process.env.IPTV_SERVER_URL?.trim();
    const username = process.env.IPTV_USERNAME?.trim();
    const password = process.env.IPTV_PASSWORD;

    if (!serverUrl && !username && !password) return null;

    if (!serverUrl || !username || !password) {
        throw new Error(
            'IPTV_SERVER_URL, IPTV_USERNAME ve IPTV_PASSWORD birlikte ayarlanmalı.',
        );
    }

    return { serverUrl, username, password };
}

function getXtreamCacheKey(
    credentials: XtreamCredentials,
    type: ContentType,
    categoryId: string,
): string {
    const value = [
        credentials.serverUrl,
        credentials.username,
        credentials.password,
        type,
        categoryId,
    ].join('|');

    return createHash('sha256').update(value).digest('hex');
}

function cleanXtreamCache(): void {
    const now = Date.now();

    for (const [key, entry] of xtreamItemsCache.entries()) {
        if (entry.expiresAt <= now) {
            xtreamItemsCache.delete(key);
        }
    }

    while (xtreamItemsCache.size > XTREAM_CACHE_MAX_ENTRIES) {
        const oldestKey = xtreamItemsCache.keys().next().value;

        if (!oldestKey) break;

        xtreamItemsCache.delete(oldestKey);
    }
}

// --------------------------------------------------
// HTTP yanıtını sınırlı boyutta okuma
// --------------------------------------------------

async function readLimitedResponse(
    response: Response,
    maxSize: number,
): Promise<string> {
    const contentLength = Number(
        response.headers.get('content-length') || 0,
    );

    if (contentLength > maxSize) {
        await response.body?.cancel();
        throw new Error('Sağlayıcı yanıtı boyut sınırını aşıyor.');
    }

    if (!response.body) {
        throw new Error('Sağlayıcı boş yanıt döndürdü.');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            totalSize += value.length;

            if (totalSize > maxSize) {
                await reader.cancel();
                throw new Error('Sağlayıcı yanıtı boyut sınırını aşıyor.');
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    return new TextDecoder().decode(Buffer.concat(chunks));
}

// --------------------------------------------------
// Xtream API
// --------------------------------------------------

async function requestXtream<T>(
    credentials: XtreamCredentials,
    action?: string,
    parameters: Record<string, string> = {},
): Promise<T> {
    const server = await validateServerUrl(credentials.serverUrl);
    const apiUrl = new URL('/player_api.php', server);

    apiUrl.searchParams.set('username', credentials.username);
    apiUrl.searchParams.set('password', credentials.password);

    if (action) {
        apiUrl.searchParams.set('action', action);
    }

    for (const [key, value] of Object.entries(parameters)) {
        apiUrl.searchParams.set(key, value);
    }

    let response: Response | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptController = new AbortController();
        const attemptTimeout = setTimeout(
            () => attemptController.abort(),
            REQUEST_TIMEOUT,
        );

        try {
            response = await fetch(apiUrl, {
                method: 'GET',
                redirect: 'error',
                signal: attemptController.signal,
                headers: {
                    Accept: 'application/json, text/plain, */*',
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
            });
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('Xtream API zamanında yanıt vermedi.');
            }

            throw new Error('Xtream API bağlantısı kurulamadı.');
        } finally {
            clearTimeout(attemptTimeout);
        }

        if (response.status !== 520 || attempt === 1) break;

        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 400));
    }

    if (!response) {
        throw new Error('Xtream API yanıt vermedi.');
    }

    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Xtream API HTTP ${response.status} yanıtı verdi.`);
    }

    const responseText = await readLimitedResponse(
        response,
        MAX_API_RESPONSE_SIZE,
    );

    try {
        return JSON.parse(responseText) as T;
    } catch {
        throw new Error('Sağlayıcı geçerli bir JSON yanıtı döndürmedi.');
    }
}

function asArray<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

function asStringOrNumber(value: unknown): string | number | null {
    return typeof value === 'string' || typeof value === 'number'
        ? value
        : null;
}

function extractXtreamSubtitles(...values: unknown[]): XtreamSubtitleTrack[] {
    const entries = values.flatMap((value) => {
        if (Array.isArray(value)) return value;
        if (!value || typeof value !== 'object') return [];

        const objectValue = value as Record<string, unknown>;
        if (objectValue.url || objectValue.file || objectValue.subtitle_url) {
            return [objectValue];
        }

        return Object.entries(objectValue).map(
            ([language, item]) =>
                typeof item === 'string'
                    ? { language, url: item }
                    : item && typeof item === 'object'
                      ? { language, ...(item as Record<string, unknown>) }
                      : null,
        ).filter((item) => item !== null);
    });
    const tracks = new Map<string, XtreamSubtitleTrack>();

    for (const entry of entries) {
        const record =
            typeof entry === 'string'
                ? { url: entry }
                : entry && typeof entry === 'object'
                  ? (entry as Record<string, unknown>)
                  : null;
        if (!record) continue;

        const rawUrl = [record.url, record.file, record.subtitle_url]
            .find((value) => typeof value === 'string' && value.trim()) as
            | string
            | undefined;
        if (!rawUrl || rawUrl.length > 2048) continue;

        let url: URL;
        try {
            url = new URL(rawUrl);
        } catch {
            continue;
        }

        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password
        ) {
            continue;
        }

        const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
        if (extension !== 'srt' && extension !== 'vtt') continue;

        const language = String(
            record.language ?? record.lang ?? record.code ?? '',
        ).trim();
        const label = String(
            record.label ?? record.name ?? language ?? 'Altyazı',
        ).trim();
        tracks.set(url.toString(), {
            label: label || 'Altyazı',
            language,
            url: url.toString(),
            format: extension,
        });

        if (tracks.size >= 20) break;
    }

    return Array.from(tracks.values());
}

// --------------------------------------------------
// Yayın adresi oluşturma
// --------------------------------------------------

function buildStreamUrl(
    credentials: XtreamCredentials,
    type: 'live' | 'movie' | 'series',
    id: string,
    extension: string,
): string {
    if (!/^\d+$/.test(id)) {
        throw new Error('Geçersiz yayın kimliği.');
    }

    const server = new URL(credentials.serverUrl);
    const safeUsername = encodeURIComponent(credentials.username);
    const safePassword = encodeURIComponent(credentials.password);
    const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, '');

    server.pathname = [
        '',
        type,
        safeUsername,
        safePassword,
        `${id}.${safeExtension}`,
    ].join('/');

    server.search = '';
    server.hash = '';

    return server.toString();
}

function configuredStreamExtension(defaultExtension: string): string {
    const format = process.env.IPTV_STREAM_FORMAT?.trim().toLowerCase();

    if (format === 'hls' || format === 'm3u8') return 'm3u8';
    if (format === 'mpegts' || format === 'ts') return 'ts';

    return defaultExtension;
}

// --------------------------------------------------
// Xtream bağlantı testi
// --------------------------------------------------

interface XtreamUserInfo {
    auth?: number | string | boolean;
    status?: string;
    exp_date?: string | null;
    is_trial?: string | number;
    active_cons?: string | number;
    max_connections?: string | number;
}

interface XtreamAuthResponse {
    user_info?: XtreamUserInfo;
}

async function testXtreamConnection(credentials: XtreamCredentials) {
    const result = await requestXtream<XtreamAuthResponse>(credentials);

    if (!result?.user_info) {
        throw new Error('Sağlayıcı Xtream API formatında yanıt vermiyor.');
    }

    const userInfo = result.user_info;
    const authenticated =
        userInfo.auth === true || String(userInfo.auth) === '1';

    if (!authenticated) {
        throw new Error('Xtream API kullanıcı adı veya şifreyi doğrulayamadı.');
    }

    return {
        authenticated: true,
        status: userInfo.status || 'Unknown',
        expirationDate: userInfo.exp_date || null,
        isTrial: String(userInfo.is_trial) === '1',
        activeConnections: Number(userInfo.active_cons || 0),
        maxConnections: Number(userInfo.max_connections || 0),
    };
}

app.post('/api/iptv/test-xtream', async (req, res) => {
    try {
        const credentials = getCredentials(req.body);
        const result = await testXtreamConnection(credentials);

        xtreamCredentials = credentials;
        xtreamConnectedAt = Date.now();
        xtreamEnvironmentError = null;
        xtreamItemsCache.clear();
        xtreamSearchIndexCache.clear();

        console.log('[IPTV] Xtream API bağlantısı başarılı.');

        return res.json({ success: true, ...result });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Bilinmeyen bağlantı hatası';

        console.error('[IPTV Xtream Test Error]', message);

        return res.status(502).json({
            success: false,
            error: message,
        });
    }
});

// Frontend may restore the configured session, but never receives its secrets.
app.get('/api/iptv/xtream/session', (_req, res) => {
    try {
        getActiveCredentials();
        return res.json({ ready: true });
    } catch {
        return res.json({ ready: false, error: xtreamEnvironmentError });
    }
});

// --------------------------------------------------
// Xtream kategorileri
// --------------------------------------------------

app.get('/api/iptv/xtream/categories', async (req, res) => {
    try {
        const type = req.query.type;

        const actions: Record<ContentType, string> = {
            live: 'get_live_categories',
            movie: 'get_vod_categories',
            series: 'get_series_categories',
        };

        if (
            typeof type !== 'string' ||
            !Object.prototype.hasOwnProperty.call(actions, type)
        ) {
            return res.status(400).json({ error: 'Geçersiz içerik türü.' });
        }

        const credentials = getActiveCredentials();
        const result = await requestXtream<unknown>(
            credentials,
            actions[type as ContentType],
        );

        const categories = asArray<Record<string, unknown>>(result)
            .map((category) => ({
                category_id: String(category.category_id ?? ''),
                category_name: String(
                    category.category_name ?? 'İsimsiz kategori',
                ),
                parent_id:
                    category.parent_id == null
                        ? null
                        : String(category.parent_id),
            }))
            .filter((category) => category.category_id);

        return res.json({
            type,
            categories,
            total: categories.length,
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Kategori listesi alınamadı.';

        console.error('[IPTV Categories Error]', message);

        return res.status(502).json({ error: message });
    }
});

// --------------------------------------------------
// Xtream içerik listesi - önbellek + sayfalama
// --------------------------------------------------

async function getXtreamCategoryItems(
    credentials: XtreamCredentials,
    type: ContentType,
    categoryId: string,
): Promise<XtreamCachedItem[]> {
    const cacheKey = getXtreamCacheKey(credentials, type, categoryId);
    cleanXtreamCache();

    const cached = xtreamItemsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    const actions: Record<ContentType, string> = {
        live: 'get_live_streams',
        movie: 'get_vod_streams',
        series: 'get_series',
    };
    const parameters: Record<string, string> = {};
    if (categoryId) parameters.category_id = categoryId;

    console.log('[IPTV] Xtream kategori verisi alınıyor:', {
        type,
        categoryId: categoryId || 'Tümü',
    });

    const result = await requestXtream<unknown>(
        credentials,
        actions[type],
        parameters,
    );
    const providerItems = asArray<Record<string, unknown>>(result);
    const items: XtreamCachedItem[] = providerItems
        .map((item) => {
            const id = String(item.stream_id ?? item.series_id ?? '');
            const providerExtension = String(item.container_extension ?? '')
                .replace(/[^a-zA-Z0-9]/g, '');
            const extension = type === 'live'
                ? configuredStreamExtension('ts')
                : providerExtension || 'mp4';
            let url = '';

            if (type === 'live') {
                url = buildStreamUrl(credentials, 'live', id, extension);
            } else if (type === 'movie') {
                url = buildStreamUrl(credentials, 'movie', id, extension);
            }

            return {
                id,
                name: String(item.name ?? item.title ?? 'İsimsiz içerik'),
                url,
                logo: typeof item.stream_icon === 'string'
                    ? item.stream_icon
                    : typeof item.cover === 'string' ? item.cover : null,
                group: String(item.category_name ?? item.category_id ?? 'Diğer'),
                categoryId: item.category_id == null ? null : String(item.category_id),
                type,
                ...(type === 'series' ? {
                    cover: typeof item.cover === 'string' ? item.cover : null,
                    plot: typeof item.plot === 'string' ? item.plot : null,
                    year: asStringOrNumber(item.releaseDate ?? item.year),
                    rating: asStringOrNumber(item.rating),
                } : {}),
            };
        })
        .filter((item) => item.id);

    xtreamItemsCache.set(cacheKey, {
        items,
        expiresAt: Date.now() + CACHE_DURATION,
    });
    cleanXtreamCache();
    console.log('[IPTV] Xtream kategori önbelleğe alındı:', {
        type,
        categoryId: categoryId || 'Tümü',
        total: items.length,
    });
    return items;
}

async function getXtreamSearchIndex(
    credentials: XtreamCredentials,
    type: ContentType,
): Promise<XtreamCachedItem[]> {
    const cacheKey = getXtreamCacheKey(credentials, type, '__search_index__');
    const cached = xtreamSearchIndexCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    let items: XtreamCachedItem[];
    if (type === 'live') {
        items = await getXtreamCategoryItems(credentials, type, '');
    } else {
        const action = type === 'movie' ? 'get_vod_categories' : 'get_series_categories';
        const categoryResponse = await requestXtream<unknown>(credentials, action);
        const categories = asArray<Record<string, unknown>>(categoryResponse)
            .map((category) => ({
                id: String(category.category_id ?? ''),
                name: String(category.category_name ?? ''),
            }))
            .filter((category) => category.id);
        const byCategory = new Map<string, XtreamCachedItem[]>();

        // Keep provider traffic bounded while scanning every category.
        for (let offset = 0; offset < categories.length; offset += 4) {
            const batch = categories.slice(offset, offset + 4);
            const results = await Promise.all(batch.map(async (category) => ({
                category,
                items: await getXtreamCategoryItems(credentials, type, category.id),
            })));
            for (const result of results) {
                byCategory.set(result.category.id, result.items.map((item) => ({
                    ...item,
                    group: result.category.name || item.group,
                })));
            }
        }

        const unique = new Map<string, XtreamCachedItem>();
        for (const category of categories) {
            for (const item of byCategory.get(category.id) || []) {
                unique.set(item.id, item);
            }
        }
        items = Array.from(unique.values());
    }

    xtreamSearchIndexCache.set(cacheKey, {
        items,
        expiresAt: Date.now() + CACHE_DURATION,
    });
    while (xtreamSearchIndexCache.size > 3) {
        const oldestKey = xtreamSearchIndexCache.keys().next().value;
        if (!oldestKey) break;
        xtreamSearchIndexCache.delete(oldestKey);
    }
    return items;
}

app.get('/api/iptv/xtream/items', async (req, res) => {
    try {
        const type = req.query.type;

        if (type !== 'live' && type !== 'movie' && type !== 'series') {
            return res.status(400).json({ error: 'Geçersiz içerik türü.' });
        }

        const categoryId =
            typeof req.query.categoryId === 'string'
                ? req.query.categoryId.trim()
                : '';
        // Film ve dizilerde kategori seçimi zorunlu.
        // Böylece yüz binlerce kaydın tek istekte çekilmesi engellenir.
        if (type !== 'live' && !categoryId) {
            return res.status(400).json({
                error: 'İçerikleri görüntülemek için önce bir kategori seçin.',
            });
        }

        const page = Math.max(
            1,
            Number.parseInt(String(req.query.page || '1'), 10) || 1,
        );

        const limit = Math.min(
            XTREAM_PAGE_SIZE_MAX,
            Math.max(
                1,
                Number.parseInt(
                    String(req.query.limit || XTREAM_PAGE_SIZE_DEFAULT),
                    10,
                ) || XTREAM_PAGE_SIZE_DEFAULT,
            ),
        );

        const credentials = getActiveCredentials();

        const items = await getXtreamCategoryItems(
            credentials,
            type,
            categoryId,
        );

        const total = items.length;
        const start = (page - 1) * limit;
        const pageItems = items.slice(start, start + limit);

        return res.json({
            type,
            items: pageItems,
            total,
            page,
            limit,
            hasMore: start + limit < total,
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'İçerikler alınamadı.';

        console.error('[IPTV Items Error]', message);

        return res.status(502).json({ error: message });
    }
});

app.get('/api/iptv/xtream/search', async (req, res) => {
    try {
        const type = req.query.type;
        const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (type !== 'live' && type !== 'movie' && type !== 'series') {
            return res.status(400).json({ error: 'Geçersiz içerik türü.' });
        }
        if (query.length < 2 || query.length > 100) {
            return res.status(400).json({ error: 'Arama en az 2, en fazla 100 karakter olmalı.' });
        }

        const credentials = getActiveCredentials();
        const items = await getXtreamSearchIndex(credentials, type);
        const normalizedQuery = query.toLocaleLowerCase('tr-TR');
        const matches = items.filter((item) =>
            `${item.name} ${item.group}`
                .toLocaleLowerCase('tr-TR')
                .includes(normalizedQuery),
        );
        matches.sort((a, b) => {
            const aStarts = a.name.toLocaleLowerCase('tr-TR').startsWith(normalizedQuery);
            const bStarts = b.name.toLocaleLowerCase('tr-TR').startsWith(normalizedQuery);
            return Number(bStarts) - Number(aStarts) || a.name.localeCompare(b.name, 'tr');
        });

        return res.json({
            type,
            items: matches.slice(0, 100),
            total: matches.length,
            limit: 100,
            categoriesSearched: type === 'live' ? null : new Set(items.map((item) => item.categoryId)).size,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'IPTV araması yapılamadı.';
        console.error('[IPTV Search Error]', message);
        return res.status(502).json({ error: message });
    }
});

// Xtream VOD details can include provider-supplied sidecar subtitles.
app.get('/api/iptv/xtream/vod/:vodId', async (req, res) => {
    try {
        const { vodId } = req.params;
        if (!/^\d+$/.test(vodId)) {
            return res.status(400).json({ error: 'Geçersiz film kimliği.' });
        }

        const credentials = getActiveCredentials();
        const result = await requestXtream<{
            info?: Record<string, unknown>;
            movie_data?: Record<string, unknown>;
            subtitles?: unknown;
        }>(credentials, 'get_vod_info', { vod_id: vodId });

        const movieData = result.movie_data || {};
        const providerExtension = String(
            movieData.container_extension || 'mp4',
        ).replace(/[^a-zA-Z0-9]/g, '') || 'mp4';
        const extension = providerExtension;

        return res.json({
            url: buildStreamUrl(credentials, 'movie', vodId, extension),
            extension,
            subtitles: extractXtreamSubtitles(
                result.info?.subtitles,
                result.subtitles,
                movieData.subtitles,
            ),
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Film bilgileri alınamadı.';
        console.error('[IPTV VOD Info Error]', message);
        return res.status(502).json({ error: message });
    }
});

// Proxy HLS manifests and media fragments so browser playback does not depend
// on the IPTV provider enabling cross-origin requests.
const streamProxyPaths = ['/api/iptv/stream', '/api/iptv/stream/:filename'];

const handleIptvStream = async (req: Request, res: ExpressResponse) => {
    try {
        const credentials = getActiveCredentials();
        const rawUrl = req.query.url;
        if (typeof rawUrl !== 'string' || rawUrl.length > 4096) {
            return res.status(400).json({ error: 'Geçersiz yayın adresi.' });
        }

        const streamUrl = new URL(rawUrl);
        if (
            !['http:', 'https:'].includes(streamUrl.protocol) ||
            streamUrl.username ||
            streamUrl.password
        ) {
            return res.status(400).json({ error: 'Yayın adresi desteklenmiyor.' });
        }

        const providerHost = new URL(credentials.serverUrl).hostname.toLowerCase();
        const allowedHosts = (process.env.IPTV_STREAM_HOSTS || '')
            .split(',')
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean);
        if (
            streamUrl.hostname.toLowerCase() !== providerHost &&
            !allowedHosts.includes(streamUrl.hostname.toLowerCase())
        ) {
            return res.status(403).json({ error: 'Bu yayın sunucusuna izin verilmiyor.' });
        }

        await validateServerUrl(`${streamUrl.protocol}//${streamUrl.host}/`);
        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableFinished) controller.abort();
        });
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        let upstream: Response;
        const clientRange = req.header('range');
        try {
            const headers = new Headers({
                Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, video/*, */*',
            });
            // Some Xtream servers claim HEAD support but return no length. VLC
            // probes remote media with HEAD before it opens the demuxer; use a
            // one-byte ranged GET for that probe so it gets the total size.
            const range = clientRange ||
                (req.method === 'HEAD' ? 'bytes=0-0' : undefined);
            if (range) headers.set('Range', range);
            let currentUrl = streamUrl;
            for (let redirects = 0; ; redirects += 1) {
                upstream = await fetch(currentUrl, {
                    headers,
                    redirect: 'manual',
                    signal: controller.signal,
                });
                const location = upstream.headers.get('location');
                if (![301, 302, 303, 307, 308].includes(upstream.status) || !location) break;
                await upstream.body?.cancel();
                if (redirects >= 5) throw new Error('Yayın sunucusu çok fazla yönlendirme yaptı.');

                const nextUrl = new URL(location, currentUrl);
                if (
                    !['http:', 'https:'].includes(nextUrl.protocol) ||
                    nextUrl.username ||
                    nextUrl.password
                ) {
                    throw new Error('Yayın sunucusu güvenli olmayan bir adrese yönlendirdi.');
                }
                // Provider CDNs often live on a different host. Validate each hop
                // against private-network access before following it.
                await validateServerUrl(`${nextUrl.protocol}//${nextUrl.host}/`);
                currentUrl = nextUrl;
            }
            streamUrl.href = currentUrl.href;
        } finally {
            clearTimeout(timeout);
        }

        if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel();
            return res.status(502).json({ error: `Yayın sunucusu HTTP ${upstream.status} yanıtı verdi.` });
        }

        const contentType = upstream.headers.get('content-type') || '';
        const isPlaylist = /\.m3u8$/i.test(streamUrl.pathname) || /mpegurl/i.test(contentType);
        res.setHeader('Cache-Control', 'no-store');

        // The one-byte GET above is only an internal HEAD fallback. Report the
        // full entity size to VLC's lazy-file layer, which uses HEAD's
        // Content-Length as the size of the remote file.
        if (req.method === 'HEAD' && !clientRange) {
            if (contentType) res.setHeader('Content-Type', contentType);
            const totalSize = upstream.headers
                .get('content-range')
                ?.match(/\/(\d+)$/)?.[1];
            const knownLength = totalSize || upstream.headers.get('content-length');
            if (knownLength) res.setHeader('Content-Length', knownLength);
            if (upstream.status === 206 || upstream.headers.has('content-range')) {
                res.setHeader('Accept-Ranges', 'bytes');
            }
            await upstream.body?.cancel();
            return res.status(200).end();
        }

        if (isPlaylist) {
            const playlist = await readLimitedResponse(upstream, MAX_HLS_PLAYLIST_SIZE);
            const playbackToken = typeof req.query.playback_token === 'string'
                ? req.query.playback_token
                : '';
            const proxyUrl = (uri: string) => {
                const resolved = new URL(uri, streamUrl);
                const parameters = new URLSearchParams({ url: resolved.toString() });
                if (playbackToken) parameters.set('playback_token', playbackToken);
                return `/api/iptv/stream?${parameters.toString()}`;
            };
            const rewritten = playlist
                .split(/\r?\n/)
                .map((line) => {
                    const trimmed = line.trim();
                    if (!trimmed) return line;
                    if (trimmed.startsWith('#')) {
                        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${proxyUrl(uri)}"`);
                    }
                    return proxyUrl(trimmed);
                })
                .join('\n');
            return res.type('application/vnd.apple.mpegurl; charset=utf-8').send(rewritten);
        }

        for (const header of ['content-type', 'content-range']) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
        }
        // Some IPTV providers put the available byte span (e.g. "0-1234")
        // in Accept-Ranges instead of the HTTP token "bytes". Normalize it so
        // browser decoders can reliably discover range support.
        const supportsRanges =
            upstream.status === 206 || upstream.headers.has('content-range') ||
            /^bytes$/i.test(upstream.headers.get('accept-ranges') || '');
        if (supportsRanges) res.setHeader('Accept-Ranges', 'bytes');
        const contentLength = upstream.headers.get('content-length');
        if (contentLength && !upstream.headers.get('content-encoding')) {
            res.setHeader('Content-Length', contentLength);
        }
        res.status(upstream.status);
        if (req.method === 'HEAD') {
            await upstream.body?.cancel();
            return res.end();
        }
        const bodyStream = Readable.fromWeb(
            upstream.body as import('node:stream/web').ReadableStream,
        );
        bodyStream.on('error', (error) => {
            if (!res.headersSent) return res.status(502).end();
            res.destroy(error);
        });
        bodyStream.pipe(res);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Yayın alınamadı.';
        console.error('[IPTV Stream Proxy Error]', message);
        if (!res.headersSent) return res.status(502).json({ error: message });
        res.destroy(error instanceof Error ? error : undefined);
    }
};

app.get(streamProxyPaths, handleIptvStream);
app.head(streamProxyPaths, handleIptvStream);

// Fetch subtitle sidecars server-side so provider CORS settings do not hide them.
app.get('/api/iptv/subtitle', async (req, res) => {
    try {
        const credentials = getActiveCredentials();
        const rawUrl = req.query.url;
        if (typeof rawUrl !== 'string' || rawUrl.length > 2048) {
            return res.status(400).json({ error: 'Geçersiz altyazı adresi.' });
        }

        const subtitleUrl = new URL(rawUrl);
        if (
            !['http:', 'https:'].includes(subtitleUrl.protocol) ||
            subtitleUrl.username ||
            subtitleUrl.password ||
            !/\.(srt|vtt)$/i.test(subtitleUrl.pathname)
        ) {
            return res.status(400).json({ error: 'Altyazı biçimi desteklenmiyor.' });
        }

        const configuredHosts = (process.env.IPTV_SUBTITLE_HOSTS || '')
            .split(',')
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean);
        const providerHost = new URL(credentials.serverUrl).hostname.toLowerCase();
        if (
            subtitleUrl.hostname.toLowerCase() !== providerHost &&
            !configuredHosts.includes(subtitleUrl.hostname.toLowerCase())
        ) {
            return res.status(403).json({ error: 'Bu altyazı sunucusuna izin verilmiyor.' });
        }

        await validateServerUrl(`${subtitleUrl.protocol}//${subtitleUrl.host}/`);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        let response: Response;
        try {
            response = await fetch(subtitleUrl, {
                redirect: 'error',
                signal: controller.signal,
                headers: { Accept: 'text/plain, text/vtt, */*' },
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            await response.body?.cancel();
            return res.status(502).json({ error: 'Altyazı sağlayıcıdan alınamadı.' });
        }

        const text = await readLimitedResponse(response, MAX_SUBTITLE_SIZE);
        return res.type('text/plain; charset=utf-8').send(text);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Altyazı alınamadı.';
        console.error('[IPTV Subtitle Error]', message);
        return res.status(502).json({ error: message });
    }
});

// --------------------------------------------------
// Xtream dizi detayları, sezonlar ve bölümler
// --------------------------------------------------

interface XtreamEpisode {
    id?: string | number;
    episode_num?: number;
    title?: string;
    container_extension?: string;
    subtitles?: unknown;
    info?: {
        movie_image?: string;
        plot?: string;
        duration?: string;
        [key: string]: unknown;
    };
}

interface XtreamSeriesInfo {
    info?: Record<string, unknown>;
    seasons?: Array<Record<string, unknown>>;
    episodes?: Record<string, XtreamEpisode[]>;
}

app.get('/api/iptv/xtream/series/:seriesId', async (req, res) => {
    try {
        const { seriesId } = req.params;

        if (!/^\d+$/.test(seriesId)) {
            return res.status(400).json({ error: 'Geçersiz dizi kimliği.' });
        }

        const credentials = getActiveCredentials();

        const result = await requestXtream<XtreamSeriesInfo>(
            credentials,
            'get_series_info',
            { series_id: seriesId },
        );

        const seasons = asArray<Record<string, unknown>>(
            result.seasons,
        ).map((season) => ({
            id: String(season.id ?? season.season_number ?? ''),
            name: String(
                season.name ??
                `Sezon ${season.season_number ?? ''}`.trim(),
            ),
            seasonNumber: Number(
                season.season_number ?? season.id ?? 0,
            ),
            episodeCount: Number(season.episode_count ?? 0),
        }));

        const episodesBySeason = Object.entries(
            result.episodes || {},
        ).map(([seasonKey, episodes]) => ({
            seasonId: seasonKey,
            episodes: asArray<XtreamEpisode>(episodes).map((episode) => {
                const id = String(episode.id ?? '');

                const providerExtension = String(
                    episode.container_extension || 'mp4',
                ).replace(/[^a-zA-Z0-9]/g, '');
                const extension = providerExtension || 'mp4';

                return {
                    id,
                    name: episode.title || 'İsimsiz bölüm',
                    episodeNumber: Number(episode.episode_num ?? 0),
                    url: buildStreamUrl(
                        credentials,
                        'series',
                        id,
                        extension || 'mp4',
                    ),
                    extension,
                    info: episode.info || {},
                    subtitles: extractXtreamSubtitles(
                        episode.info?.subtitles,
                        episode.subtitles,
                    ),
                };
            }),
        }));

        return res.json({
            seriesId,
            info: result.info || {},
            seasons,
            episodesBySeason,
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Dizi detayları alınamadı.';

        console.error('[IPTV Series Error]', message);

        return res.status(502).json({ error: message });
    }
});

// --------------------------------------------------
// M3U playlist indirme
// --------------------------------------------------

async function fetchPlaylist(
    serverUrl: string,
    username: string,
    password: string,
): Promise<string> {
    const server = await validateServerUrl(serverUrl);
    const playlistUrl = new URL('/get.php', server);

    playlistUrl.searchParams.set('username', username);
    playlistUrl.searchParams.set('password', password);
    playlistUrl.searchParams.set('type', 'm3u_plus');
    playlistUrl.searchParams.set('output', 'ts');

    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT,
    );

    let response: Response;

    try {
        response = await fetch(playlistUrl, {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Accept: 'application/x-mpegURL, text/plain, */*',
            },
        });
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('IPTV sunucusu zamanında yanıt vermedi.');
        }

        throw new Error('IPTV sunucusuna bağlantı kurulamadı.');
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`IPTV sağlayıcısı HTTP ${response.status} yanıtı verdi.`);
    }

    console.log('[IPTV] HTTP Status:', response.status);
    console.log(
        '[IPTV] Content-Type:',
        response.headers.get('content-type'),
    );

    const content = await readLimitedResponse(
        response,
        MAX_PLAYLIST_SIZE,
    );

    if (!content.trimStart().startsWith('#EXTM3U')) {
        throw new Error('Sağlayıcı geçerli bir M3U listesi döndürmedi.');
    }

    console.log(
        '[IPTV] Playlist boyutu:',
        (Buffer.byteLength(content) / 1024 / 1024).toFixed(2),
        'MB',
    );

    console.log(
        '[IPTV] Playlist satır sayısı:',
        content.split(/\r?\n/).length,
    );

    return content;
}

// --------------------------------------------------
// M3U içerik türü
// --------------------------------------------------

function detectContentType(
    group: string,
    name: string,
    url: string,
): ContentType {
    const value = `${group} ${name} ${url}`.toLocaleLowerCase('tr');

    const seriesKeywords = [
        'series', 'dizi', 'season', 'sezon',
        'episode', 'bölüm', '/series/',
    ];

    const movieKeywords = [
        'movie', 'film', 'cinema',
        'sinema', 'vod', '/movie/',
    ];

    if (seriesKeywords.some((keyword) => value.includes(keyword))) {
        return 'series';
    }

    if (movieKeywords.some((keyword) => value.includes(keyword))) {
        return 'movie';
    }

    return 'live';
}

// --------------------------------------------------
// M3U ayrıştırma
// --------------------------------------------------

function parseM3u(content: string): IptvItem[] {
    const lines = content
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/);

    const items: IptvItem[] = [];

    let metadata = '';
    let group = '';

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            metadata = line;

            const groupMatch = line.match(/group-title="([^"]*)"/i);
            group = groupMatch?.[1]?.trim() || 'Diğer';

            continue;
        }

        if (line.startsWith('#EXTGRP:')) {
            group = line.slice(8).trim() || 'Diğer';
            continue;
        }

        if (line.startsWith('#')) continue;

        let url: URL;

        try {
            url = new URL(line);
        } catch {
            metadata = '';
            group = '';
            continue;
        }

        if (!['http:', 'https:'].includes(url.protocol)) {
            metadata = '';
            group = '';
            continue;
        }

        if (items.length < 5) {
            const segments = url.pathname.split('/').filter(Boolean);

            const pathStructure = segments
                .map((segment, index) => {
                    if (
                        index === 0 &&
                        ['live', 'movie', 'series'].includes(
                            segment.toLowerCase(),
                        )
                    ) {
                        return segment;
                    }

                    if (/\.(m3u8|ts)$/i.test(segment)) {
                        return segment
                            .slice(segment.lastIndexOf('.') + 1)
                            .toLowerCase();
                    }

                    return '[MASKED]';
                })
                .join('/');

            console.log('[IPTV STREAM FORMAT]', {
                protocol: url.protocol,
                hostname: url.hostname,
                pathStructure: `/${pathStructure}`,
                extension:
                    url.pathname.match(/\.(m3u8|ts)$/i)?.[1] || 'none',
            });
        }

        const nameMatch = metadata.match(/,(.*)$/);
        const logoMatch = metadata.match(/tvg-logo="([^"]*)"/i);
        const idMatch = metadata.match(/tvg-id="([^"]*)"/i);

        const name = nameMatch?.[1]?.trim() || 'İsimsiz içerik';
        const logo = logoMatch?.[1]?.trim() || null;

        const normalizedName = name
            .toLocaleLowerCase('tr')
            .replace(/\s+/g, '-');

        const id =
            idMatch?.[1]?.trim() ||
            `${group.toLocaleLowerCase('tr')}:${normalizedName}`;

        items.push({
            id,
            name,
            url: url.toString(),
            logo,
            group,
            type: detectContentType(group, name, line),
        });

        metadata = '';
        group = '';
    }

    return items;
}

// --------------------------------------------------
// M3U kataloğunu yükleme
// --------------------------------------------------

app.post('/api/iptv/catalog', async (req, res) => {
    if (isLoading) {
        return res.status(409).json({
            error: 'IPTV listesi zaten yükleniyor. Lütfen bekleyin.',
        });
    }

    isLoading = true;

    try {
        const credentials = getCredentials(req.body);

        const playlist = await fetchPlaylist(
            credentials.serverUrl,
            credentials.username,
            credentials.password,
        );

        const parsedItems = parseM3u(playlist);

        if (parsedItems.length === 0) {
            return res.status(422).json({
                error: 'M3U listesinde oynatılabilir içerik bulunamadı.',
            });
        }

        catalog = parsedItems;
        catalogLoadedAt = Date.now();

        const counts = {
            live: catalog.filter((item) => item.type === 'live').length,
            movie: catalog.filter((item) => item.type === 'movie').length,
            series: catalog.filter((item) => item.type === 'series').length,
        };

        console.log('[IPTV] M3U katalog yüklendi:', {
            total: catalog.length,
            ...counts,
        });

        return res.json({
            success: true,
            total: catalog.length,
            counts,
            loadedAt: catalogLoadedAt,
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Bilinmeyen bağlantı hatası';

        console.error('[IPTV Catalog Error]', message);

        return res.status(502).json({ error: message });
    } finally {
        isLoading = false;
    }
});

// --------------------------------------------------
// M3U katalog bilgisi
// --------------------------------------------------

app.get('/api/iptv/catalog', (_req, res) => {
    if (!catalogLoadedAt) {
        return res.status(404).json({
            error: 'Henüz IPTV kataloğu yüklenmedi.',
        });
    }

    if (Date.now() - catalogLoadedAt > CACHE_DURATION) {
        catalog = [];
        catalogLoadedAt = null;

        return res.status(410).json({
            error: 'IPTV kataloğunun süresi doldu. Yeniden yükleyin.',
        });
    }

    return res.json({
        total: catalog.length,
        counts: {
            live: catalog.filter((item) => item.type === 'live').length,
            movie: catalog.filter((item) => item.type === 'movie').length,
            series: catalog.filter((item) => item.type === 'series').length,
        },
        loadedAt: catalogLoadedAt,
    });
});

// --------------------------------------------------
// M3U sayfalı içerik listesi
// --------------------------------------------------

app.get('/api/iptv/catalog/items', (req, res) => {
    if (
        !catalogLoadedAt ||
        Date.now() - catalogLoadedAt > CACHE_DURATION
    ) {
        catalog = [];
        catalogLoadedAt = null;

        return res.status(410).json({
            error: 'IPTV kataloğu bulunamadı veya süresi doldu.',
        });
    }

    const type = req.query.type;

    const group =
        typeof req.query.group === 'string' ? req.query.group : null;

    if (type !== 'live' && type !== 'movie' && type !== 'series') {
        return res.status(400).json({ error: 'Geçersiz içerik türü.' });
    }

    const page = Math.max(
        1,
        Number.parseInt(String(req.query.page || '1'), 10) || 1,
    );

    const limit = Math.min(
        100,
        Math.max(
            1,
            Number.parseInt(String(req.query.limit || '50'), 10) || 50,
        ),
    );

    let filteredItems = catalog.filter((item) => item.type === type);

    if (group && group !== 'Tümü') {
        filteredItems = filteredItems.filter((item) => item.group === group);
    }

    const query = typeof req.query.q === 'string'
        ? req.query.q.trim().toLocaleLowerCase('tr-TR')
        : '';
    if (query) {
        filteredItems = filteredItems.filter((item) =>
            `${item.name} ${item.group}`.toLocaleLowerCase('tr-TR').includes(query),
        );
    }

    const total = filteredItems.length;
    const start = (page - 1) * limit;
    const items = filteredItems.slice(start, start + limit);

    return res.json({
        items,
        total,
        page,
        limit,
        hasMore: start + limit < total,
        groups: Array.from(
            new Set(filteredItems.map((item) => item.group)),
        ),
    });
});

// --------------------------------------------------
// Eski frontend ile geçici uyumluluk
// --------------------------------------------------

app.post('/api/iptv/playlist', async (req, res) => {
    try {
        const credentials = getCredentials(req.body);

        const playlist = await fetchPlaylist(
            credentials.serverUrl,
            credentials.username,
            credentials.password,
        );

        return res.json({ playlist });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Bilinmeyen bağlantı hatası';

        console.error('[IPTV Playlist Error]', message);

        return res.status(502).json({ error: message });
    }
});

// --------------------------------------------------
// Sunucuyu başlat
// --------------------------------------------------

let initialization: Promise<void> | null = null;

export function initializeServer(): Promise<void> {
    if (initialization) return initialization;

    initialization = (async () => {
        try {
            const credentials = getEnvironmentCredentials();

            if (credentials) {
                // Do not issue an extra Xtream login request on every cold
                // serverless instance. The first real catalog request will
                // validate provider availability and can retry transient 520s.
                xtreamCredentials = credentials;
                xtreamConnectedAt = Date.now();
                xtreamEnvironmentError = null;
                console.log('[IPTV] Sunucu ortam değişkenlerinden Xtream ayarları yüklendi.');
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Bilinmeyen bağlantı hatası';
            const errorCode =
                error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : '';
            xtreamEnvironmentError =
                errorCode === 'ENOTFOUND'
                    ? 'IPTV sunucu adresi DNS üzerinden bulunamadı. IPTV_SERVER_URL değerini sağlayıcınızın verdiği adresle kontrol edin.'
                    : message;
            console.error('[IPTV] Sunucu ortam değişkenleriyle otomatik giriş yapılamadı:', message);
        }
    })();

    return initialization;
}
