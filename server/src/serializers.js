import { resolveTrekImageUrl } from './trek-images.js';

function toPlain(value) {
  if (!value) return null;
  return typeof value.toObject === 'function' ? value.toObject() : value;
}

function isPopulated(value) {
  return Boolean(value && typeof value === 'object' && typeof value.name === 'string');
}

function referenceId(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    if (value._id) return value._id;
    if (typeof value.toHexString === 'function') return value;
    return value.id || null;
  }
  return value;
}

export function serializeUser(user) {
  const source = toPlain(user);
  if (!source) return null;
  return {
    _id: source._id,
    id: source._id,
    name: source.name,
    email: source.email || source.contactDetails || null,
    role: source.role,
    status: source.status
  };
}

export function serializePublicProfile(user) {
  const source = toPlain(user);
  if (!source) return null;
  return {
    _id: source._id,
    id: source._id,
    name: source.name,
    role: source.role
  };
}

export function serializeTrek(trek) {
  const source = toPlain(trek);
  if (!source) return null;
  const assignedStaff = source.assignedStaff;
  const staff = isPopulated(assignedStaff) ? toPlain(assignedStaff) : null;
  const assignedStaffId = referenceId(assignedStaff);
  return {
    _id: source._id,
    id: source._id,
    name: source.name,
    region: source.region,
    location: source.location,
    difficulty: source.difficulty,
    duration: source.duration,
    availableSlots: source.availableSlots,
    assignedStaffId: assignedStaffId || null,
    assignedStaffName: staff?.name || null,
    assignedStaff: staff ? { _id: staff._id || null, id: staff._id || null, name: staff.name } : null,
    status: source.status,
    startDate: source.startDate,
    endDate: source.endDate,
    imageUrl: resolveTrekImageUrl(source),
    description: source.description,
    detailedDescription: source.detailedDescription,
    price: source.price,
    avgTime: source.avgTime,
    avgDistance: source.avgDistance,
    avgGain: source.avgGain,
    avgLoss: source.avgLoss
  };
}

export function serializeBooking(booking, { includeUser = true, includeTrek = true } = {}) {
  const source = toPlain(booking);
  if (!source) return null;
  const result = {
    _id: source._id,
    id: source._id,
    bookingDate: source.bookingDate,
    status: source.status
  };
  if (includeUser) {
    const userId = referenceId(source.user);
    result.user = source.user
      ? (isPopulated(source.user) ? serializeUser(source.user) : { _id: userId, id: userId })
      : null;
  }
  if (includeTrek) {
    const trekId = referenceId(source.trek);
    result.trek = source.trek
      ? (isPopulated(source.trek) ? serializeTrek(source.trek) : { _id: trekId, id: trekId })
      : null;
  }
  return result;
}
