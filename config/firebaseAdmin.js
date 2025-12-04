import dotenv from "dotenv";
dotenv.config();   // <-- LOAD .env HERE AS WELL

import admin from "firebase-admin";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

export default function initFirebaseAdmin() {
  if (admin.apps.length > 0) return admin;

  const serviceAccountFile = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountFile) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON is missing");
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON in .env");
  }

  // Resolve absolute path
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serviceAccountPath = path.join(process.cwd(), serviceAccountFile);

  console.log("🔍 Using service account file:", serviceAccountPath);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  console.log("✅ Firebase Admin initialized");
  return admin;
}
