import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import api from './routes.js';
import { Trek } from './models.js';
import { resolveTrekImageUrl } from './trek-images.js';
import { bootstrapAdmin } from './bootstrap-admin.js';
import { getMongoUri, validateJwtConfiguration } from './config.js';
import { errorHandler } from './http.js';
import { createRateLimiters, limitWrites, resolveTrustProxy, securityHeaders } from './security.js';
import dns from "node:dns";

dns.setServers(["8.8.8.8"]);
dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const limiters = createRateLimiters(process.env);

app.set('trust proxy', resolveTrustProxy(process.env, isProd));
app.use(securityHeaders({ production: isProd }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use('/uploads', express.static(path.resolve(__dirname, '../../client/public/static/uploads')));
app.get('/api/health', (_req,res)=>res.json({ok:true,service:'trekking-management-api'}));
app.use('/api/auth/login', limiters.auth);
app.use('/api/auth/register', limiters.auth);
app.use('/api', limitWrites(limiters.write));
app.use('/api', limiters.api);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', api);

// In production, serve the Vite-built client and let React Router handle routing
if (isProd) {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use(errorHandler);

const port = process.env.PORT || 5000;
try {
  validateJwtConfiguration();
  const mongoUri = getMongoUri(process.env, { production: isProd });
  await mongoose.connect(mongoUri);
  const legacyTreks = await Trek.find({
    $or: [
      { imageFilename: /^https?:\/\//i },
      { imageFilename: /^\/(?:static\/)?uploads\/https?:\/\//i },
      { imageUrl: /^https?:\/\/images\.unsplash\.com\//i },
      { imageUrl: /^\/(?:static\/)?uploads\/https?:\/\//i }
    ]
  }).select('_id region imageUrl imageFilename').lean();
  if (legacyTreks.length) {
    await Trek.bulkWrite(legacyTreks.map(trek => ({
      updateOne: {
        filter: { _id: trek._id },
        update: { $set: {
          imageUrl: resolveTrekImageUrl(trek),
          imageFilename: ''
        } }
      }
    })));
    console.log(`Repaired legacy image references on ${legacyTreks.length} trek(s)`);
  }
  await bootstrapAdmin();
  app.listen(port, ()=>console.log(`Trekking API listening on http://localhost:${port}`));
} catch (err) {
  console.error('Server startup failed:', err.message);
  process.exit(1);
}

