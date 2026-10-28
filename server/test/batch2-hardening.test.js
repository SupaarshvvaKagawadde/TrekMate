import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import api from '../src/routes.js';
import { errorHandler } from '../src/http.js';
import { Admin, Booking, Trek, User } from '../src/models.js';
import { buildTrekListFilter, buildUserSearchFilter, escapeRegex } from '../src/query.js';
import { isAllowedTrekImageMimeType, resolveTrekImageUrl } from '../src/trek-images.js';
import { serializeTrek } from '../src/serializers.js';

const TEST_JWT_SECRET = 'batch2-test-secret-0123456789abcdef';
const validId = '507f1f77bcf86cd799439011';
const bookingId = '507f1f77bcf86cd799439012';
const trekId = '507f1f77bcf86cd799439013';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = TEST_JWT_SECRET;

function signToken(role, id = validId) {
  return jwt.sign({ id, role }, TEST_JWT_SECRET, { algorithm: 'HS256' });
}

async function withApiServer(handler) {
  const app = express();
  app.use(express.json());
  app.use('/api', api);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await handler(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function restoreMocks(mocks) {
  for (const mocked of mocks) mocked.mock.restore();
}

test('image URL resolution repairs legacy uploads and returns direct fallbacks', () => {
  assert.equal(
    resolveTrekImageUrl({ imageUrl: '/static/uploads/https://cdn.example.com/one.jpg' }),
    'https://cdn.example.com/one.jpg'
  );
  assert.equal(
    resolveTrekImageUrl({ imageUrl: '/uploads/http://cdn.example.com/two.jpg' }),
    'http://cdn.example.com/two.jpg'
  );
  assert.equal(
    resolveTrekImageUrl({ imageUrl: 'https://res.cloudinary.com/demo/image/upload/three.jpg' }),
    'https://res.cloudinary.com/demo/image/upload/three.jpg'
  );
  assert.equal(
    resolveTrekImageUrl({ imageFilename: 'https://cdn.example.com/four.jpg' }),
    'https://cdn.example.com/four.jpg'
  );
  assert.equal(
    resolveTrekImageUrl({ imageFilename: 'local-five.jpg' }),
    '/static/uploads/local-five.jpg'
  );

  const fallback = resolveTrekImageUrl({ region: 'Japan' });
  assert.match(fallback, /^https:\/\//);
  assert.equal(fallback.startsWith('/static/uploads/http'), false);

  const unsplashFallback = resolveTrekImageUrl({
    imageUrl: '/static/uploads/https://images.unsplash.com/photo.jpg'
  });
  assert.notEqual(unsplashFallback, 'https://images.unsplash.com/photo.jpg');
  assert.match(unsplashFallback, /^https:\/\//);

  const trek = serializeTrek({
    _id: validId,
    name: 'Legacy image trek',
    region: 'Nepal',
    status: 'Open',
    imageUrl: '/static/uploads/https://cdn.example.com/serialized.jpg'
  });
  assert.equal(trek.imageUrl, 'https://cdn.example.com/serialized.jpg');
});

test('trek image uploads allow only safe raster MIME types', () => {
  assert.equal(isAllowedTrekImageMimeType('image/jpeg'), true);
  assert.equal(isAllowedTrekImageMimeType('IMAGE/PNG'), true);
  assert.equal(isAllowedTrekImageMimeType('image/webp'), true);
  assert.equal(isAllowedTrekImageMimeType('image/gif'), true);
  assert.equal(isAllowedTrekImageMimeType('image/svg+xml'), false);
  assert.equal(isAllowedTrekImageMimeType('text/html'), false);
  assert.equal(isAllowedTrekImageMimeType(undefined), false);
});

test('trek filters restrict public access and escape user-supplied regex', () => {
  assert.deepEqual(buildTrekListFilter(), { status: { $in: ['Approved', 'Open'] } });
  assert.deepEqual(buildTrekListFilter({ status: 'Pending' }), { status: { $in: ['Approved', 'Open'] } });
  assert.deepEqual(buildTrekListFilter({ isAdmin: true }), {});
  assert.deepEqual(buildTrekListFilter({ isAdmin: true, status: 'Pending' }), { status: 'Pending' });
  assert.deepEqual(buildTrekListFilter({ isAdmin: true, publicOnly: true }), {
    status: { $in: ['Approved', 'Open'] }
  });
  assert.deepEqual(buildTrekListFilter({
    isAdmin: true,
    difficulty: 'Easy',
    region: 'A.*'
  }), {
    difficulty: 'Easy',
    region: { $regex: 'A\\.\\*', $options: 'i' }
  });

  assert.throws(() => buildTrekListFilter({ isAdmin: true, status: 'Unknown' }), /Invalid trek status/);
  assert.throws(() => buildTrekListFilter({ difficulty: ['Easy'] }), /Invalid trek difficulty/);
  assert.throws(() => buildTrekListFilter({ region: {} }), /Invalid region/);
  assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
});

test('admin user search escapes regex and validates query types', () => {
  assert.deepEqual(buildUserSearchFilter(undefined), {});
  assert.deepEqual(buildUserSearchFilter('a.*'), {
    $or: [{ name: { $regex: 'a\\.\\*', $options: 'i' } }]
  });
  assert.deepEqual(buildUserSearchFilter(validId), {
    $or: [
      { name: { $regex: validId, $options: 'i' } },
      { _id: validId }
    ]
  });
  assert.throws(() => buildUserSearchFilter({ $ne: null }), /Invalid search query/);
  assert.throws(() => buildUserSearchFilter('x'.repeat(101)), /too long/);
});

test('public trek listing cannot enumerate non-public statuses, while admin can', async (t) => {
  const filters = [];
  const findMock = mock.method(Trek, 'find', (filter) => {
    filters.push(filter);
    return {
      populate() { return this; },
      sort() { return Promise.resolve([]); }
    };
  });
  t.after(() => restoreMocks([findMock]));

  await withApiServer(async (baseUrl) => {
    const publicResponse = await fetch(`${baseUrl}/api/treks?status=Pending`);
    assert.equal(publicResponse.status, 200);
    assert.deepEqual(await publicResponse.json(), []);

    const adminResponse = await fetch(`${baseUrl}/api/treks`, {
      headers: { authorization: `Bearer ${signToken('Admin')}` }
    });
    assert.equal(adminResponse.status, 200);
    assert.deepEqual(await adminResponse.json(), []);
  });

  assert.deepEqual(filters[0], { status: { $in: ['Approved', 'Open'] } });
  assert.deepEqual(filters[1], {});
});

test('normal users cannot read pending trek details by ID', async (t) => {
  const pendingTrek = {
    _id: trekId,
    name: 'Pending trek',
    region: 'Nepal',
    status: 'Pending',
    startDate: new Date('2026-11-01T00:00:00.000Z'),
    endDate: new Date('2026-11-05T00:00:00.000Z')
  };
  const findByIdMock = mock.method(Trek, 'findById', () => ({
    populate: async () => pendingTrek
  }));
  t.after(() => restoreMocks([findByIdMock]));

  await withApiServer(async (baseUrl) => {
    const userResponse = await fetch(`${baseUrl}/api/treks/${trekId}`, {
      headers: { authorization: `Bearer ${signToken('User')}` }
    });
    assert.equal(userResponse.status, 404);

    const adminResponse = await fetch(`${baseUrl}/api/treks/${trekId}`, {
      headers: { authorization: `Bearer ${signToken('Admin')}` }
    });
    assert.equal(adminResponse.status, 200);
    assert.equal((await adminResponse.json()).status, 'Pending');
  });
});

test('admin user search passes escaped regex to MongoDB', async (t) => {
  let capturedFilter;
  const adminFindMock = mock.method(Admin, 'findById', async () => ({ _id: validId, role: 'Admin' }));
  const userFindMock = mock.method(User, 'find', (filter) => {
    capturedFilter = filter;
    return { sort: () => Promise.resolve([]) };
  });
  t.after(() => restoreMocks([adminFindMock, userFindMock]));

  await withApiServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/users?search=a.*`, {
      headers: { authorization: `Bearer ${signToken('Admin')}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  assert.deepEqual(capturedFilter, {
    $or: [{ name: { $regex: 'a\\.\\*', $options: 'i' } }]
  });
});

test('cancelling the same booking twice restores only one slot', async (t) => {
  let cancellationAttempts = 0;
  let slotRestorations = 0;
  const userFindMock = mock.method(User, 'findById', async () => ({
    _id: validId,
    role: 'User',
    status: 'Active'
  }));
  const bookingUpdateMock = mock.method(Booking, 'findOneAndUpdate', async () => {
    cancellationAttempts += 1;
    return cancellationAttempts === 1 ? { trek: trekId } : null;
  });
  const bookingFindMock = mock.method(Booking, 'findOne', async () => ({ status: 'Cancelled' }));
  const trekUpdateMock = mock.method(Trek, 'updateOne', async () => {
    slotRestorations += 1;
    return {};
  });
  t.after(() => restoreMocks([userFindMock, bookingUpdateMock, bookingFindMock, trekUpdateMock]));

  await withApiServer(async (baseUrl) => {
    const headers = { authorization: `Bearer ${signToken('User')}` };
    const first = await fetch(`${baseUrl}/api/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers
    });
    const second = await fetch(`${baseUrl}/api/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  });

  assert.equal(cancellationAttempts, 2);
  assert.equal(slotRestorations, 1);
});
