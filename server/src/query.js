export const TREK_PUBLIC_STATUSES = ['Approved', 'Open'];
export const TREK_USER_DETAIL_STATUSES = ['Approved', 'Open', 'Started', 'Completed'];

const TREK_STATUSES = new Set(['Pending', 'Approved', 'Open', 'Started', 'Completed']);
const DIFFICULTIES = new Set(['Easy', 'Moderate', 'Difficult']);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTrekListFilter({
  status,
  publicOnly = false,
  difficulty,
  region,
  isAdmin = false
} = {}) {
  const filter = {};

  if (isAdmin) {
    if (status !== undefined) {
      if (typeof status !== 'string' || !TREK_STATUSES.has(status)) {
        throw badRequest('Invalid trek status.');
      }
      filter.status = status;
    } else if (publicOnly) {
      filter.status = { $in: TREK_PUBLIC_STATUSES };
    }
  } else {
    filter.status = { $in: TREK_PUBLIC_STATUSES };
  }

  if (difficulty !== undefined) {
    if (typeof difficulty !== 'string' || !DIFFICULTIES.has(difficulty)) {
      throw badRequest('Invalid trek difficulty.');
    }
    filter.difficulty = difficulty;
  }

  if (region !== undefined) {
    if (typeof region !== 'string') throw badRequest('Invalid region filter.');
    const trimmed = region.trim();
    if (trimmed.length > 80) throw badRequest('Region filter is too long.');
    if (trimmed) filter.region = { $regex: escapeRegex(trimmed), $options: 'i' };
  }

  return filter;
}

export function buildUserSearchFilter(search) {
  if (search === undefined) return {};
  if (typeof search !== 'string') throw badRequest('Invalid search query.');

  const query = search.trim();
  if (!query) return {};
  if (query.length > 100) throw badRequest('Search query is too long.');

  const filter = {
    $or: [{ name: { $regex: escapeRegex(query), $options: 'i' } }]
  };
  if (/^[0-9a-f]{24}$/i.test(query)) filter.$or.push({ _id: query });
  return filter;
}
