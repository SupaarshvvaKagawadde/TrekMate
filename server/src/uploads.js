import multer from 'multer';
import { isAllowedTrekImageMimeType } from './trek-images.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isAllowedTrekImageMimeType(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed.'));
    }
    cb(null, true);
  }
});

export function handleImageUpload(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: error.message });
    next();
  });
}
