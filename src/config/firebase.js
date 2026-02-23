import admin from 'firebase-admin';
import { readFileSync } from 'fs';

let serviceAccount;

// Service account ni olish
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // JSON string sifatida (hosting uchun)
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  // Fayl sifatida
  serviceAccount = JSON.parse(
    readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8')
  );
} else {
  throw new Error('Firebase service account not configured');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

export const db = admin.firestore();
export default admin;
