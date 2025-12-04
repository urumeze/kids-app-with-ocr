// routes/firebasePosts.js
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import initFirebaseAdmin from "../config/firebaseAdmin.js";

const router = express.Router();
const admin = initFirebaseAdmin();
const db = admin.firestore();
const bucket = admin.storage().bucket(); // uses FIREBASE_STORAGE_BUCKET from init

// Multer in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 } // 8 MB
});

// Auth middleware: expects Authorization: Bearer <Firebase ID Token>
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const idToken = match ? match[1] : null;
  if (!idToken) return res.status(401).json({ error: "Missing auth token" });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (err) {
    console.error("Token verify failed:", err);
    return res.status(401).json({ error: "Invalid auth token" });
  }
}

// Helper: upload buffer to GCS and return file object
async function uploadBufferToGCS(buffer, destinationPath, contentType) {
  const file = bucket.file(destinationPath);
  const streamOpts = {
    metadata: {
      contentType,
      metadata: {
        firebaseStorageDownloadTokens: uuidv4(),
      },
    },
    resumable: false,
  };
  await file.save(buffer, streamOpts);
  await file.setMetadata({ cacheControl: "public, max-age=31536000" });
  return file;
}

// Helper: get signed URL
async function getSignedUrl(file, expiresSeconds = parseInt(process.env.SIGNED_URL_EXPIRES || "604800", 10)) {
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + expiresSeconds * 1000,
  });
  return url;
}

// ----------------------
// CREATE POST
// ----------------------
router.post("/create", verifyAuth, upload.single("image"), async (req, res) => {
  try {
    const { text = "" } = req.body;
    const userId = req.user.uid;
    const media = [];

    if (req.file && req.file.buffer) {
      const originalBuffer = req.file.buffer;
      const contentType = req.file.mimetype || "image/jpeg";
      const ext = contentType.split("/")[1] || "jpg";
      const idBase = uuidv4();

      const originalPath = `posts/${userId}/${idBase}.${ext}`;
      const thumbPath = `posts/${userId}/${idBase}_thumb.webp`;

      // Thumbnail
      let thumbBuffer;
      try {
        thumbBuffer = await sharp(originalBuffer).resize({ width: 400 }).webp({ quality: 75 }).toBuffer();
      } catch (e) {
        console.warn("Thumbnail generation failed:", e);
      }

      const originalFile = await uploadBufferToGCS(originalBuffer, originalPath, contentType);
      const thumbFile = thumbBuffer ? await uploadBufferToGCS(thumbBuffer, thumbPath, "image/webp") : null;

      const originalUrl = await getSignedUrl(originalFile);
      const thumbUrl = thumbFile ? await getSignedUrl(thumbFile) : null;

      media.push({ storagePath: originalPath, contentType, size: req.file.size, url: originalUrl, thumbnailUrl: thumbUrl });
    }

    const postDoc = {
      userId,
      text,
      media,
      likes: [],
      commentsCount: 0,
      status: "live",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("posts").add(postDoc);
    const saved = await docRef.get();

    res.json({ success: true, id: docRef.id, post: { id: docRef.id, ...saved.data() } });
  } catch (err) {
    console.error("Create post error:", err);
    res.status(500).json({ success: false, error: "Could not create post" });
  }
});

// ----------------------
// TEACHER POST
// ----------------------
// ----------------------------------------------
// CREATE TEACHER POST (Name, Gender, Subject, Image)
// ----------------------------------------------
router.post("/teacher", upload.single("image"), async (req, res) => {
  try {
    const { name, gender, subject } = req.body;

    if (!name || !gender || !subject) {
      return res.status(400).json({
        success: false,
        error: "All fields are required"
      });
    }

    let imageUrl = null;

    // --- HANDLE IMAGE UPLOAD SAFELY ---
    if (req.file && req.file.buffer) {
      try {
        console.log("Received file:", req.file);

        const contentType = req.file.mimetype || "image/jpeg";

        // Prevent crash if file type is weird
        let ext = "jpg";
        if (contentType.includes("/")) {
          ext = contentType.split("/")[1];
        }

        const idBase = uuidv4();
        const filePath = `teachers/${idBase}.${ext}`;

        // Upload to Firebase Storage
        const file = await uploadBufferToGCS(
          req.file.buffer,
          filePath,
          contentType
        );

        // Get signed download URL
        imageUrl = await getSignedUrl(file);

      } catch (uploadErr) {
        console.error("🔥 IMAGE UPLOAD FAILED:", uploadErr);
        return res.status(500).json({
          success: false,
          error: "Image upload failed"
        });
      }
    }

    // --- SAVE TEACHER DOCUMENT ---
    const teacherDoc = {
      name,
      gender,
      subject,
      imageUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("teachers").add(teacherDoc);
    const saved = await docRef.get();

    res.json({
      success: true,
      id: docRef.id,
      teacher: { id: docRef.id, ...saved.data() }
    });

  } catch (err) {
    console.error("🔥 TEACHER POST ERROR:", err);
    res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
});
// ----------------------
// FEED
// ----------------------
router.get("/feed", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const postsSnap = await db.collection("posts").orderBy("createdAt", "desc").limit(limit).get();
    const posts = postsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, posts });
  } catch (err) {
    console.error("Feed error:", err);
    res.status(500).json({ success: false, error: "Could not load feed" });
  }
});

// ----------------------
// LIKE TOGGLE
// ----------------------
router.post("/like/:postId", verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const postId = req.params.postId;
    const postRef = db.collection("posts").doc(postId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(postRef);
      if (!snap.exists) throw new Error("Post not found");
      const data = snap.data();
      const likes = Array.isArray(data.likes) ? data.likes : [];
      const index = likes.indexOf(uid);
      if (index === -1) likes.push(uid);
      else likes.splice(index, 1);
      tx.update(postRef, { likes, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Like error:", err);
    res.status(500).json({ success: false, error: "Could not toggle like" });
  }
});



export default router;
