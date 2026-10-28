import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import api from '../src/routes.js';
import { validateJwtSecret } from '../src/config.js';
import { asyncHandler, errorHandler, isValidObjectId, validateObjectIdParam } from '../src/http.js';
import { serializeBooking, serializePublicProfile, serializeTrek, serializeUser } from '../src/serializers.js';
import { bootstrapAdmin, resolveAdminBootstrapConfig } from '../src/bootstrap-admin.js';

const validJwtSecret = '0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const validObjectId = '507f1f77bcf86cd799439011';

function createResponse() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
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

function makeLogger() {
  const messages = { info: [], warn: [] };
  return {
    messages,
    log: {
      info(message) { messages.info.push(message); },
      warn(message) { messages.warn.push(message); }
    }
  };
}

function makeFakeAdmin({ existing = null, createError = null } = {}) {
  const created = [];
  return {
    created,
    model: {
      async findOne() {
        return existing;
      },
      async create(document) {
        if (createError) throw createError;
        created.push(document);
        return document;
      }
    }
  };
}

const trekFixture = {
  _id: 'trek-1',
  name: 'Everest Base Camp',
  region: 'Nepal',
  location: 'Nepal',
  difficulty: 'Moderate',
  duration: 12,
  availableSlots: 5,
  assignedStaff: {
    _id: 'staff-1',
    name: 'Guide One',
    contactDetails: 'guide@example.com',
    passwordHash: '$2b$12$private-hash',
    role: 'Staff',
    status: 'Approved'
  },
  status: 'Open',
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-11-12T00:00:00.000Z'),
  imageUrl: '/static/uploads/everest.jpg',
  imageFilename: 'private-filename.jpg',
  description: 'A trek',
  detailedDescription: '# Details',
  price: 1200,
  avgTime: '6 h',
  avgDistance: '10 km',
  avgGain: '+500 m',
  avgLoss: '-450 m',
  __v: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z')
};

test('JWT secret validation rejects missing, short, weak, and low-variety production secrets', () => {
  assert.throws(() => validateJwtSecret(undefined, { production: true }), /required/);
  assert.throws(() => validateJwtSecret('short', { production: true }), /at least 32/);
  assert.throws(() => validateJwtSecret('development-secret-change-me', { production: true }), /weak placeholder/);
  assert.throws(() => validateJwtSecret('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { production: true }), /unique characters/);
  assert.equal(validateJwtSecret(validJwtSecret, { production: true }), validJwtSecret);
  assert.equal(validateJwtSecret('development-only-secret', { production: false }), 'development-only-secret');
});

test('ObjectId validation accepts only strict 24-character hexadecimal identifiers', () => {
  assert.equal(isValidObjectId(validObjectId), true);
  assert.equal(isValidObjectId('not-an-id'), false);
  assert.equal(isValidObjectId('507f1f77bcf86cd'), false);
  assert.equal(isValidObjectId(null), false);
  assert.equal(isValidObjectId({ $ne: null }), false);
});

test('validateObjectIdParam rejects malformed IDs without calling the handler', () => {
  const response = createResponse();
  let nextCalled = false;
  const middleware = validateObjectIdParam();
  middleware({ params: { id: 'bad-id' } }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.message, 'Invalid identifier.');

  const validResponse = createResponse();
  middleware({ params: { id: validObjectId } }, validResponse, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('asyncHandler forwards rejected promises to the error handler', async () => {
  const failure = new Error('boom');
  const handler = asyncHandler(async () => {
    throw failure;
  });
  await new Promise((resolve) => {
    handler({}, createResponse(), (error) => {
      assert.equal(error, failure);
      resolve();
    });
  });
});

test('errorHandler hides internal errors and handles malformed JSON', () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = createResponse();
    errorHandler(new Error('database password leaked'), {}, response, () => {});
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.body, { message: 'Internal server error.' });
  } finally {
    console.error = originalError;
  }

  const parseResponse = createResponse();
  errorHandler({ type: 'entity.parse.failed', status: 400, message: 'Unexpected token' }, {}, parseResponse, () => {});
  assert.equal(parseResponse.statusCode, 400);
  assert.deepEqual(parseResponse.body, { message: 'Invalid JSON body.' });
});

test('malformed IDs and JSON are handled by the API without database access or crashes', async () => {
  await withApiServer(async (baseUrl) => {
    const invalidId = await fetch(`${baseUrl}/api/users/not-an-objectid`);
    assert.equal(invalidId.status, 400);
    assert.deepEqual(await invalidId.json(), { message: 'Invalid identifier.' });

    const missingRoute = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(missingRoute.status, 404);
    assert.deepEqual(await missingRoute.json(), { message: 'API endpoint not found.' });

    const malformedJson = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(malformedJson.status, 400);
    assert.deepEqual(await malformedJson.json(), { message: 'Invalid JSON body.' });
  });
});

test('serializers return explicit allowlists and never expose password hashes', () => {
  const user = serializeUser({
    _id: 'user-1',
    name: 'Trekker',
    email: 'trekker@example.com',
    passwordHash: '$2b$12$private-hash',
    role: 'User',
    status: 'Active',
    __v: 0
  });
  assert.deepEqual(Object.keys(user).sort(), ['_id', 'email', 'id', 'name', 'role', 'status']);
  assert.equal(user.passwordHash, undefined);
  assert.equal(user.__v, undefined);

  const publicProfile = serializePublicProfile({
    _id: 'user-1',
    name: 'Trekker',
    email: 'trekker@example.com',
    role: 'User'
  });
  assert.deepEqual(Object.keys(publicProfile).sort(), ['_id', 'id', 'name', 'role']);
  assert.equal(publicProfile.email, undefined);

  const trek = serializeTrek(trekFixture);
  assert.equal(trek.name, 'Everest Base Camp');
  assert.equal(trek.assignedStaffName, 'Guide One');
  assert.equal(trek.assignedStaffId, 'staff-1');
  assert.deepEqual(Object.keys(trek.assignedStaff).sort(), ['_id', 'id', 'name']);
  assert.equal(trek.assignedStaff.passwordHash, undefined);
  assert.equal(trek.assignedStaff.contactDetails, undefined);
  assert.equal(trek.imageFilename, undefined);
  assert.equal(trek.__v, undefined);
  assert.equal(trek.createdAt, undefined);
  assert.equal(trek.imageUrl, '/static/uploads/everest.jpg');
});

test('booking serializer does not leak populated user or trek internals', () => {
  const booking = serializeBooking({
    _id: 'booking-1',
    bookingDate: new Date('2026-10-01T00:00:00.000Z'),
    status: 'Booked',
    user: {
      _id: 'user-1',
      name: 'Trekker',
      email: 'trekker@example.com',
      passwordHash: '$2b$12$private-hash',
      role: 'User',
      status: 'Active'
    },
    trek: trekFixture,
    __v: 0
  });
  assert.equal(booking.user.passwordHash, undefined);
  assert.equal(booking.user.email, 'trekker@example.com');
  assert.equal(booking.trek.assignedStaff.passwordHash, undefined);
  assert.equal(booking.trek.assignedStaff.contactDetails, undefined);
  assert.equal(booking.__v, undefined);

  const staffView = serializeBooking({
    _id: 'booking-1',
    bookingDate: new Date('2026-10-01T00:00:00.000Z'),
    status: 'Booked',
    user: {
      _id: 'user-1',
      name: 'Trekker',
      email: 'trekker@example.com',
      passwordHash: '$2b$12$private-hash',
      role: 'User',
      status: 'Active'
    },
    trek: trekFixture
  }, { includeTrek: false });
  assert.equal('trek' in staffView, false);
  assert.equal(staffView.user.passwordHash, undefined);

  const references = serializeBooking({
    _id: 'booking-1',
    user: { _id: 'user-1' },
    trek: { _id: 'trek-1' }
  });
  assert.equal(references.user.id, 'user-1');
  assert.equal(references.trek.id, 'trek-1');
  assert.equal(references.user.passwordHash, undefined);
});

test('admin bootstrap config is absent by default and validates provided credentials', () => {
  assert.equal(resolveAdminBootstrapConfig({}), null);
  assert.throws(() => resolveAdminBootstrapConfig({ ADMIN_EMAIL: 'admin@example.com' }), /provided together/);
  assert.throws(() => resolveAdminBootstrapConfig({ ADMIN_EMAIL: 'bad-email', ADMIN_PASSWORD: 'long-enough-password' }), /valid email/);
  assert.throws(() => resolveAdminBootstrapConfig({ ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'short' }), /at least 12/);
  assert.throws(() => resolveAdminBootstrapConfig({ ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'admin123' }), /at least 12/);
  assert.throws(() => resolveAdminBootstrapConfig({ ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'aaaaaaaaaaaa' }), /unique characters/);

  assert.deepEqual(resolveAdminBootstrapConfig({
    ADMIN_EMAIL: 'ADMIN@Example.com',
    ADMIN_PASSWORD: 'CorrectHorseBattery42!',
    ADMIN_NAME: 'Operations Admin'
  }), {
    email: 'admin@example.com',
    password: 'CorrectHorseBattery42!',
    name: 'Operations Admin'
  });
});

test('admin bootstrap never creates a default account without environment credentials', async () => {
  const { messages, log } = makeLogger();
  const fake = makeFakeAdmin();
  const result = await bootstrapAdmin({ env: {}, log, adminModel: fake.model });
  assert.deepEqual(result, { created: false, adminExists: false });
  assert.equal(fake.created.length, 0);
  assert.match(messages.warn[0], /No admin account exists/);
});

test('admin bootstrap creates the configured account without storing plaintext password', async () => {
  const { messages, log } = makeLogger();
  const fake = makeFakeAdmin();
  const result = await bootstrapAdmin({
    env: {
      ADMIN_EMAIL: 'Admin@Example.com',
      ADMIN_PASSWORD: 'CorrectHorseBattery42!',
      ADMIN_NAME: 'Operations Admin'
    },
    log,
    adminModel: fake.model,
    hashPassword: async () => 'hashed-password'
  });
  assert.equal(result.created, true);
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0].email, 'admin@example.com');
  assert.equal(fake.created[0].name, 'Operations Admin');
  assert.equal(fake.created[0].passwordHash, 'hashed-password');
  assert.equal(fake.created[0].password, undefined);
  assert.match(messages.info[0], /Administrator account created/);
});

test('admin bootstrap skips creation when an admin already exists or a concurrent create wins', async () => {
  const existingFake = makeFakeAdmin({ existing: { _id: 'existing-admin' } });
  const { messages, log } = makeLogger();
  const existingResult = await bootstrapAdmin({
    env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'CorrectHorseBattery42!' },
    log,
    adminModel: existingFake.model
  });
  assert.deepEqual(existingResult, { created: false, adminExists: true });
  assert.equal(existingFake.created.length, 0);
  assert.match(messages.warn[0], /already exists/);

  const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
  const concurrentFake = makeFakeAdmin({ createError: duplicate });
  const concurrentLogger = makeLogger();
  const concurrentResult = await bootstrapAdmin({
    env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'CorrectHorseBattery42!' },
    log: concurrentLogger.log,
    adminModel: concurrentFake.model,
    hashPassword: async () => 'hashed-password'
  });
  assert.deepEqual(concurrentResult, { created: false, adminExists: true });
  assert.match(concurrentLogger.messages.warn[0], /created concurrently/);
});
