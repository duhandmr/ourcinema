import type { Request, Response } from 'express';
import { app, initializeServer } from '../server';

export default async function handler(
    request: Request,
    response: Response,
) {
    await initializeServer();
    return app(request, response);
}
