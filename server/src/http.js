import mongoose from 'mongoose';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export function isValidObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value) && mongoose.Types.ObjectId.isValid(value);
}

export function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function validateObjectIdParam(param = 'id') {
  return function validateObjectId(req, res, next) {
    if (!isValidObjectId(req.params[param])) {
      return res.status(400).json({ message: 'Invalid identifier.' });
    }
    return next();
  };
}

export function apiNotFound(_req, res) {
  return res.status(404).json({ message: 'API endpoint not found.' });
}

export function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON body.' });
  }
  const status = Number(error?.status || error?.statusCode) || 500;
  if (status >= 500) {
    console.error('Request failed:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
  return res.status(status).json({ message: error.message || 'Request failed.' });
}
