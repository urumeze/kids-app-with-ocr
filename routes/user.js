import express from "express";
import { firestore, auth } from "../config/firebaseAdmin.js";

const router = express.Router();

router.get("/wallet", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.+)$/);
    const idToken = match ? match[1] : null;

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Missing auth token"
      });
    }

    // 🔐 VERIFY TOKEN
    const decoded = await auth.verifyIdToken(idToken);
    const uid = decoded.uid;

    // 🔎 FETCH USER
    const userSnap = await firestore
      .collection("users")
      .doc(uid)
      .get();

    if (!userSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "User wallet not found"
      });
    }

    const { coinBalance } = userSnap.data();

    return res.json({
      success: true,
      coinBalance: coinBalance ?? 0
    });

  } catch (err) {
    console.error("🔥 WALLET API ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
});

export default router;
