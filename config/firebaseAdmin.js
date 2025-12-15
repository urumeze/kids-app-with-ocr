// firebaseAdmin.js
import dotenv from "dotenv";
dotenv.config(); // Load .env variables

import admin from "firebase-admin";
import path from "path";
import { fileURLToPath } from "url"; // Not strictly needed if using process.cwd() for path resolution
import { dirname } from "path"; // Not strictly needed if using process.cwd() for path resolution
import fs from "fs"; // Import the file system module

// Define module-scoped variables to hold the initialized services
let initializedAdminApp = null; // Store the initialized app instance
let _firestore = null;
let _bucket = null;
let _auth = null; // New: To store the auth service

function initializeAdminServices() {
  if (initializedAdminApp) {
    // If the app is already initialized, just return the existing services
    console.log("✅ Firebase Admin services already initialized.");
    return { firestore: _firestore, bucket: _bucket, auth: _auth };
  }

  const serviceAccountFile = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountFile) {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON is missing in your .env file.");
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON in .env. Please provide the path to your service account key JSON file.");
  }

  const serviceAccountPath = path.join(process.cwd(), serviceAccountFile);
  console.log("🔍 Using service account file:", serviceAccountPath);

  let serviceAccount;
  try {
    const serviceAccountJson = fs.readFileSync(serviceAccountPath, 'utf8');
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (error) {
    console.error(`❌ Failed to read or parse service account file at ${serviceAccountPath}:`, error);
    throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON file: ${error.message}`);
  }

  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!storageBucket) {
    console.warn("⚠️ FIREBASE_STORAGE_BUCKET is not set in your .env file. Cloud Storage may not function correctly.");
  }

  // Initialize the Firebase Admin App
  initializedAdminApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: storageBucket,
  });

  // Get the initialized service instances
  _firestore = initializedAdminApp.firestore(); // Use initializedAdminApp to get services
  _bucket = initializedAdminApp.storage().bucket(); // Use initializedAdminApp to get services
  _auth = initializedAdminApp.auth(); // New: Get the auth service

  console.log("✅ Firebase Admin initialized successfully.");

  return { firestore: _firestore, bucket: _bucket, auth: _auth };
}

// Call the initialization function once when this module is loaded.
// This ensures that `_firestore`, `_bucket`, and `_auth` are populated.
initializeAdminServices();

// Export the initialized service instances directly
export const firestore = _firestore;
export const bucket = _bucket;
export const auth = _auth; // New: Export the auth service

