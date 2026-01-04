import { firestore } from "../config/firebaseAdmin.js";
import { Timestamp } from "firebase-admin/firestore";

export async function initUser(uid, email) {
  const userRef = firestore.collection("users").doc(uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    console.log(`🎁 Initializing new user: ${uid}`);
    await userRef.set({
      email: email || null,
      coinBalance: 30, 
      createdAt: Timestamp.now(),
      // Adding a default role or status is common in 2026 apps
      role: "user",
      isVerified: false 
    }, { merge: true }); 
  }
}
