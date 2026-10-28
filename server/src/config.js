const WEAK_JWT_SECRETS = new Set([
  'development-secret-change-me',
  'replace-this-with-a-long-random-secret',
  'your_super_secret_jwt_key',
  'change-me',
  'changeme',
  'jwt-secret',
  'jwt_secret',
  'secret',
  'secretkey',
  'password',
  'admin123',
  'trekmate',
  'trekmate-secret'
]);

export function validateJwtSecret(value, { production = process.env.NODE_ENV === 'production' } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('JWT_SECRET is required. Set it to a long random value.');
  }
  if (production) {
    if (WEAK_JWT_SECRETS.has(value.toLowerCase())) {
      throw new Error('JWT_SECRET matches a known weak placeholder. Generate a unique random secret.');
    }
    if (value.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters in production.');
    }
    if (new Set(value).size < 10) {
      throw new Error('JWT_SECRET does not contain enough unique characters. Generate a random secret.');
    }
  }
  return value;
}

export function getJwtSecret() {
  return validateJwtSecret(process.env.JWT_SECRET);
}

export function validateJwtConfiguration() {
  return getJwtSecret();
}

export function getMongoUri(env = process.env, { production = env.NODE_ENV === 'production' } = {}) {
  const value = typeof env.MONGODB_URI === 'string' ? env.MONGODB_URI.trim() : '';
  if (!value) {
    if (production) throw new Error('MONGODB_URI is required in production.');
    return 'mongodb://127.0.0.1:27017/trekking_management';
  }
  if (!/^mongodb(?:\+srv)?:\/\//i.test(value)) {
    throw new Error('MONGODB_URI must start with mongodb:// or mongodb+srv://.');
  }
  return value;
}
