import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { getMongoUri } from '../src/config.js';
import { errorHandler } from '../src/http.js';
import { createRateLimiters, resolveTrustProxy, securityHeaders } from '../src/security.js';
import { handleImageUpload } from '../src/uploads.js';

async function withServer(app, handler) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('production Helmet headers allow the SPA, CDN styles/fonts, and HTTPS images', async () => {
  const app = express();
  app.use(securityHeaders({ production: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);

    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /font-src 'self' data: https:\/\/cdn\.jsdelivr\.net https:\/\/fonts\.gstatic\.com/);
    assert.match(csp, /img-src 'self' data: https:/);
    assert.equal(csp.includes("'unsafe-eval'"), false);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  });
});

test('development Helmet headers avoid CSP and HSTS while retaining safe headers', async () => {
  const app = express();
  app.use(securityHeaders({ production: false }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), null);
    assert.equal(response.headers.get('strict-transport-security'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
  });
});

test('rate limits are configurable and return a JSON 429 response', async () => {
  const limiters = createRateLimiters({
    NODE_ENV: 'production',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_MAX: '2'
  });
  const app = express();
  app.get('/api/limited', limiters.api, (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/limited`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/limited`)).status, 200);
    const limited = await fetch(`${baseUrl}/api/limited`);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { message: 'Too many requests. Please try again later.' });
  });
});

test('trust proxy defaults to one hop in production and can be overridden', () => {
  assert.equal(resolveTrustProxy({ NODE_ENV: 'production' }, true), 1);
  assert.equal(resolveTrustProxy({ NODE_ENV: 'development' }, false), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: 'false' }, true), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '0' }, true), 0);
  assert.equal(resolveTrustProxy({ TRUST_PROXY: '2' }, true), 2);
});

test('production requires a valid MongoDB URI while development keeps the local default', () => {
  assert.equal(getMongoUri({ MONGODB_URI: ' mongodb+srv://cluster.example/db ' }, { production: true }), 'mongodb+srv://cluster.example/db');
  assert.equal(getMongoUri({}, { production: false }), 'mongodb://127.0.0.1:27017/trekking_management');
  assert.throws(() => getMongoUri({}, { production: true }), /MONGODB_URI is required in production/);
  assert.throws(() => getMongoUri({ MONGODB_URI: 'https://not-mongo.example' }, { production: true }), /must start with mongodb/);
});

test('Multer 2 accepts raster uploads and rejects SVG through the upload middleware', async () => {
  const app = express();
  app.post('/upload', handleImageUpload, (req, res) => res.json({
    mimetype: req.file.mimetype,
    size: req.file.size
  }));
  app.use(errorHandler);

  await withServer(app, async (baseUrl) => {
    const jpegForm = new FormData();
    jpegForm.append('image', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), 'tiny.jpg');
    const accepted = await fetch(`${baseUrl}/upload`, { method: 'POST', body: jpegForm });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { mimetype: 'image/jpeg', size: 4 });

    const svgForm = new FormData();
    svgForm.append('image', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'bad.svg');
    const rejected = await fetch(`${baseUrl}/upload`, { method: 'POST', body: svgForm });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { message: 'Only JPEG, PNG, WebP, or GIF images are allowed.' });
  });
});
