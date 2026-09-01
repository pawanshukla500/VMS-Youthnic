import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import dotenv from 'dotenv';

dotenv.config();

const CORS_CONFIG = [
  {
    origin: ['*'],
    method: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD', 'OPTIONS'],
    responseHeader: ['Content-Type', 'Authorization', 'Content-Length', 'User-Agent', 'x-goog-resumable'],
    maxAgeSeconds: 3600
  }
];

async function configureStorageCors() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!bucketName) {
    console.error('FIREBASE_STORAGE_BUCKET environment variable is not set');
    process.exit(1);
  }

  if (!serviceAccountJson) {
    console.error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set');
    process.exit(1);
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    
    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount),
        storageBucket: bucketName
      });
    }

    const bucket = getStorage().bucket(bucketName);
    
    console.log(`Configuring CORS for bucket: ${bucketName}`);
    
    const [metadata] = await bucket.getMetadata();
    console.log('Current CORS configuration:', JSON.stringify(metadata.cors, null, 2));
    
    await bucket.setCorsConfiguration(CORS_CONFIG);
    
    const [updatedMetadata] = await bucket.getMetadata();
    console.log('Updated CORS configuration:', JSON.stringify(updatedMetadata.cors, null, 2));
    
    console.log('CORS configuration applied successfully!');
  } catch (error) {
    console.error('Failed to configure CORS:', error);
    process.exit(1);
  }
}

configureStorageCors();