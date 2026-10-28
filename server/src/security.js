import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_API_LIMIT = 600;
const DEFAULT_AUTH_LIMIT = 30;
const DEFAULT_WRITE_LIMIT = 120;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveTrustProxy(env = process.env, production = env.NODE_ENV === 'production') {
  const configured = String(env.TRUST_PROXY ?? '').trim();
  if (!configured) return production ? 1 : false;
  if (configured === 'false') return false;
  if (configured === 'true') return 1;
  const hops = Number(configured);
  return Number.isInteger(hops) && hops >= 0 ? hops : configured;
}

export function buildHelmetOptions({ production = process.env.NODE_ENV === 'production' } = {}) {
  return {
    contentSecurityPolicy: production
      ? {
          useDefaults: false,
          directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'"],
            manifestSrc: ["'self'"],
            workerSrc: ["'self'"]
          }
        }
      : false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    xFrameOptions: { action: 'deny' },
    strictTransportSecurity: production
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: 'no-referrer' }
  };
}

export function securityHeaders(options) {
  return helmet(buildHelmetOptions(options));
}

export function createRateLimiters(env = process.env) {
  const windowMs = positiveInteger(env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
  const common = {
    windowMs,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    handler: (_req, res, _next, options) => res.status(options.statusCode).json({
      message: 'Too many requests. Please try again later.'
    })
  };

  return {
    api: rateLimit({ ...common, limit: positiveInteger(env.RATE_LIMIT_MAX, DEFAULT_API_LIMIT) }),
    auth: rateLimit({ ...common, limit: positiveInteger(env.AUTH_RATE_LIMIT_MAX, DEFAULT_AUTH_LIMIT) }),
    write: rateLimit({ ...common, limit: positiveInteger(env.WRITE_RATE_LIMIT_MAX, DEFAULT_WRITE_LIMIT) })
  };
}

export function limitWrites(limiter) {
  return function limitWriteRequests(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    return limiter(req, res, next);
  };
}
