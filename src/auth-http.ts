import type { RequestHandler, Response } from 'express';
import { AuthStore, hash, now } from './auth-store.js';

export const authHeaders: RequestHandler = (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
};

export function authRateLimit(store: AuthStore, action: string, maximum: number): RequestHandler {
  return (req, res, next) => {
    // Do not trust caller-supplied forwarding headers. Behind Caddy this budget
    // is shared by its source address; edge limits can distinguish clients.
    const key = hash(`${action}:${req.socket.remoteAddress || 'unknown'}`);
    const accepted = store.transaction(() => {
      const rate = store.get<{ count: number; expires: number }>('rate', key)
        || { count: 0, expires: now() + 60 };
      if (rate.count >= maximum) return false;
      rate.count++;
      store.put('rate', key, rate, rate.expires);
      return true;
    });
    if (!accepted) {
      res.status(429).set('Retry-After', '60').json({ error: 'slow_down' });
      return;
    }
    next();
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function htmlPage(res: Response, title: string, content: string, status = 200, formRedirect?: string): void {
  const target = formRedirect ? ` ${new URL(formRedirect).origin}` : '';
  res.status(status).set('Content-Security-Policy', `default-src 'none'; form-action 'self'${target}; frame-ancestors 'none'; base-uri 'none'`)
    .type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`);
}
