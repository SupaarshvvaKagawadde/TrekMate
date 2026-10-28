import bcrypt from 'bcryptjs';
import { Admin } from './models.js';

const MIN_ADMIN_PASSWORD_LENGTH = 12;
const WEAK_ADMIN_PASSWORDS = new Set([
  'admin',
  'admin123',
  'adminadmin',
  'administrator',
  'changeme',
  'change-me',
  'letmein',
  'password',
  'password123',
  'qwerty',
  'trekmate',
  '123456789012'
]);

export function validateAdminPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`);
  }
  if (WEAK_ADMIN_PASSWORDS.has(password.toLowerCase())) {
    throw new Error('ADMIN_PASSWORD is too common. Choose a unique password.');
  }
  if (new Set(password).size < 6) {
    throw new Error('ADMIN_PASSWORD does not contain enough unique characters.');
  }
  return password;
}

export function resolveAdminBootstrapConfig(env = process.env) {
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = env.ADMIN_PASSWORD || '';
  const name = String(env.ADMIN_NAME || 'Administrator').trim() || 'Administrator';
  if (!email && !password) return null;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be provided together.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('ADMIN_EMAIL must be a valid email address.');
  }
  validateAdminPassword(password);
  return { email, password, name };
}

export async function bootstrapAdmin({
  env = process.env,
  log = console,
  adminModel = Admin,
  hashPassword = (password) => bcrypt.hash(password, 12)
} = {}) {
  const existing = await adminModel.findOne({});
  if (existing) {
    if (env.ADMIN_EMAIL || env.ADMIN_PASSWORD) {
      log.warn?.('An admin account already exists; ADMIN_EMAIL/ADMIN_PASSWORD bootstrap values were ignored.');
    }
    return { created: false, adminExists: true };
  }
  const config = resolveAdminBootstrapConfig(env);
  if (!config) {
    log.warn?.('No admin account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD once to bootstrap an administrator securely.');
    return { created: false, adminExists: false };
  }
  const passwordHash = await hashPassword(config.password);
  try {
    await adminModel.create({
      name: config.name,
      email: config.email,
      passwordHash,
      role: 'Admin'
    });
  } catch (error) {
    if (error?.code === 11000) {
      log.warn?.('Admin bootstrap skipped because another administrator was created concurrently.');
      return { created: false, adminExists: true };
    }
    throw error;
  }
  log.info?.(`Administrator account created for ${config.email}.`);
  return { created: true, adminExists: false, email: config.email };
}
