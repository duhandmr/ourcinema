import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import { app, initializeServer } from '../server/index.ts';

const DEFAULT_IPTV_REMOTE_ORIGIN = 'https://rfc-plasma-introducing-institutes.trycloudflare.com';

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
    if (request.method === 'GET' || request.method === 'HEAD') return undefined;

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 64 * 1024) throw new Error('İstek gövdesi çok büyük.');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

async function proxyToHomeApi(
    request: IncomingMessage,
    response: ServerResponse,
    remoteOrigin: string,
    path: string,
    query: URLSearchParams,
) {
    const method = (request.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST'].includes(method)) {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD, POST');
        response.end();
        return;
    }

    // Stream bytes directly from the home tunnel to the browser. Do not hold
    // IPTV live streams open inside a time-limited Vercel function.
    if (path === 'stream' || path.startsWith('stream/')) {
        const target = new URL(`/api/iptv/${path}`, remoteOrigin);
        target.search = query.toString();
        response.statusCode = 307;
        response.setHeader('Location', target.toString());
        response.setHeader('Cache-Control', 'no-store');
        response.end();
        return;
    }

    let body: Buffer | undefined;
    try {
        body = await readRequestBody(request);
    } catch (error) {
        response.statusCode = 413;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'İstek gövdesi okunamadı.' }));
        return;
    }

    const target = new URL(`/api/iptv/${path}`, remoteOrigin);
    target.search = query.toString();
    const headers = new Headers();
    for (const header of ['authorization', 'accept', 'content-type', 'range', 'if-none-match']) {
        const value = request.headers[header];
        if (typeof value === 'string') headers.set(header, value);
    }

    let upstream: globalThis.Response;
    try {
        upstream = await fetch(target, {
            method,
            headers,
            body: body?.length ? body.toString('utf8') : undefined,
            redirect: 'manual',
            signal: AbortSignal.timeout(30_000),
        });
    } catch {
        response.statusCode = 502;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Ev IPTV API sunucusuna ulaşılamıyor.' }));
        return;
    }

    response.statusCode = upstream.status;
    for (const header of [
        'accept-ranges', 'cache-control', 'content-disposition', 'content-length',
        'content-range', 'content-type', 'etag', 'last-modified',
    ]) {
        const value = upstream.headers.get(header);
        if (value) response.setHeader(header, value);
    }

    const responseBody = await upstream.arrayBuffer();
    response.end(Buffer.from(responseBody));
}

export default async function handler(
    request: IncomingMessage,
    response: ServerResponse,
) {
    const originalUrl = new URL(request.url || '/', 'https://ourcinema.invalid');
    const forwardedPath = originalUrl.searchParams.get('path');

    if (
        !forwardedPath ||
        !/^[a-zA-Z0-9/_.-]+$/.test(forwardedPath) ||
        forwardedPath.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Geçersiz IPTV API yolu.' }));
        return;
    }

    originalUrl.searchParams.delete('path');

    const configuredRemoteOrigin = process.env.IPTV_REMOTE_API_ORIGIN?.trim();
    const remoteOrigin = configuredRemoteOrigin || DEFAULT_IPTV_REMOTE_ORIGIN;
    if (remoteOrigin) {
        try {
            await proxyToHomeApi(request, response, remoteOrigin, forwardedPath, originalUrl.searchParams);
        } catch {
            if (!response.headersSent) {
                response.statusCode = 502;
                response.setHeader('Content-Type', 'application/json; charset=utf-8');
                response.end(JSON.stringify({ error: 'Ev IPTV API isteği tamamlanamadı.' }));
            }
        }
        return;
    }

    await initializeServer();
    request.url = `/api/iptv/${forwardedPath}${originalUrl.search}`;

    return app(request as Request, response as Response);
}
