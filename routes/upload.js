// routes/upload.js
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import initFirebaseAdmin from "../config/firebaseAdmin.js";

const router = express.Router();
const admin = initFirebaseAdmin();
const bucket = admin.storage().bucket(); // uses FIREBASE_STORAGE_BUCKET

// Multer in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

// Helper: upload buffer to GCS and return file object
async function uploadBufferToGCS(buffer, destinationPath, contentType) {
  const file = bucket.file(destinationPath);
  await file.save(buffer, {
    metadata: {
      contentType,
      metadata: { firebaseStorageDownloadTokens: uuidv4() },
    },
    resumable: false,
  });
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

/* --------------------------------
   Existing Single Image Upload
-------------------------------- */
router.post("/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: "No image provided" });
    }

    const originalBuffer = req.file.buffer;
    const contentType = req.file.mimetype || "image/jpeg";
    const ext = contentType.split("/")[1] || "jpg";
    const idBase = uuidv4();
    const originalPath = `uploads/${idBase}.${ext}`;
    const thumbPath = `uploads/${idBase}_thumb.webp`;

    // Generate thumbnail
    let thumbBuffer;
    try {
      thumbBuffer = await sharp(originalBuffer).resize({ width: 400 }).webp({ quality: 75 }).toBuffer();
    } catch (e) {
      console.warn("Thumbnail generation failed:", e);
    }

    // Upload original
    const originalFile = await uploadBufferToGCS(originalBuffer, originalPath, contentType);

    // Upload thumbnail
    let thumbFile = null;
    if (thumbBuffer) {
      thumbFile = await uploadBufferToGCS(thumbBuffer, thumbPath, "image/webp");
    }

    // Signed URLs
    const originalUrl = await getSignedUrl(originalFile);
    const thumbUrl = thumbFile ? await getSignedUrl(thumbFile) : null;

    res.json({
      success: true,
      url: originalUrl,
      thumbnailUrl: thumbUrl,
      storagePath: originalPath,
      contentType,
      size: req.file.size,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ success: false, error: "Upload failed" });
  }
});

/* --------------------------------
   New Teacher Upload Endpoint
-------------------------------- */
router.post("/teacher", upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: "No image provided" });
    }

    const buffer = req.file.buffer;
    const contentType = req.file.mimetype || "image/jpeg";
    const ext = contentType.split("/")[1] || "jpg";
    const idBase = uuidv4();
    const filePath = `teachers/${idBase}.${ext}`;

    // Upload teacher image
    const file = await uploadBufferToGCS(buffer, filePath, contentType);

    // Generate signed URL (public)
    const imageUrl = await getSignedUrl(file);

    // Save teacher info to Firestore
    const firestore = admin.firestore();
    const docRef = await firestore.collection("teachers").add({
      name: req.body.name,
      gender: req.body.gender,
      subject: req.body.subject,
      imageUrl, // <- used by frontend overlay
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      teacherId: docRef.id,
      imageUrl,
    });
  } catch (err) {
    console.error("Teacher upload error:", err);
    res.status(500).json({ success: false, error: "Upload failed" });
  }
});





export default router;
