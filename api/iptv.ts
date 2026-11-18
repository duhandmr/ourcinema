import type { Request, Response } from 'express';
import { app, initializeServer } from '../server';

export default async function handler(request: Request, response: Response) {
    await initializeServer();

    const originalUrl = new URL(request.url || '/', 'https://ourcinema.invalid');
    const forwardedPath = request.query.path;

    if (typeof forwardedPath !== 'string' || !/^[a-zA-Z0-9/_.-]*$/.test(forwardedPath)) {
        return response.status(400).json({ error: 'Geçersiz IPTV API yolu.' });
    }

    originalUrl.searchParams.delete('path');
    request.url = `/api/iptv/${forwardedPath}${originalUrl.search}`;

    return app(request, response);
}
