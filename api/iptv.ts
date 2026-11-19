import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Request, Response } from 'express';
import { app, initializeServer } from '../server/index.ts';

export default async function handler(
    request: IncomingMessage,
    response: ServerResponse,
) {
    await initializeServer();

    const originalUrl = new URL(request.url || '/', 'https://ourcinema.invalid');
    const forwardedPath = originalUrl.searchParams.get('path');

    if (!forwardedPath || !/^[a-zA-Z0-9/_.-]+$/.test(forwardedPath)) {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ error: 'Geçersiz IPTV API yolu.' }));
        return;
    }

    originalUrl.searchParams.delete('path');
    request.url = `/api/iptv/${forwardedPath}${originalUrl.search}`;

    return app(request as Request, response as Response);
}
