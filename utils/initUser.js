import { firestore } from "../config/firebaseAdmin.js";
import { Timestamp } from "firebase-admin/firestore";

export async function initUser(uid, email) {
  const userRef = firestore.collection("users").doc(uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    console.log(`🎁 Initializing new user: ${uid}`);
    await userRef.set({
  email: email || null,
  role: "user",
  isVerified: false,
  createdAt: Timestamp.now(),

  // ✅ leaderboard canon fields
  allTimePoints: 0,
  dailyPoints: 0,
  streakCount: 0,
  lastQuizDate: null,
}, { merge: true });
 
  }
}
