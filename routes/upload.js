// routes/upload.js
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { Timestamp } from "firebase-admin/firestore";


// --- CRITICAL FIX: Direct imports for firestore, bucket, and auth ---
// Ensure firebaseAdmin.js exports these as named exports
import { firestore, bucket, auth} from "../config/firebaseAdmin.js";

import { createMeetEvent } from "./meetingScheduler.js";
import { sendNotification } from "./emailService.js";

const router = express.Router();

// Multer in-memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
});

// --- Middleware to verify the ID Token ---
// This is crucial for securely identifying the user who sent the request
async function verifyIdToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  const idToken = match ? match[1] : null;

  if (!idToken) {
    return res.status(401).json({ success: false, error: "Unauthorized: Missing authentication token." });
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.user = decodedToken; // Attach decoded user info (contains uid, email, etc.) to the request object
    console.log("Token verified. User UID:", req.user.uid, "Email:", req.user.email);
    next(); // Proceed to the next handler
  } catch (error) {
    console.error("Error verifying ID token:", error);
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid or expired token." });
  }
}

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
async function getSignedUrl(
  file,
  expiresSeconds = parseInt(process.env.SIGNED_URL_EXPIRES || "604800", 10)
) {
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
      return res
        .status(400)
        .json({ success: false, error: "No image provided" });
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
      thumbBuffer = await sharp(originalBuffer)
        .resize({ width: 400 })
        .webp({ quality: 75 })
        .toBuffer();
    } catch (e) {
      console.warn("Thumbnail generation failed:", e);
    }

    // Upload original
    const originalFile = await uploadBufferToGCS(
      originalBuffer,
      originalPath,
      contentType
    );

    // Upload thumbnail
    let thumbFile = null;
    if (thumbBuffer) {
      thumbFile = await uploadBufferToGCS(
        thumbBuffer,
        thumbPath,
        "image/webp"
      );
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
    res
      .status(500)
      .json({ success: false, error: "Upload failed" });
  }
});

/* --------------------------------
   New Teacher Upload Endpoint (Original)
-------------------------------- */
router.post("/teacher", upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res
        .status(400)
        .json({ success: false, error: "No image provided" });
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

    const docRef = await firestore.collection("teachers").add({
      name: req.body.name,
      gender: req.body.gender,
      subject: req.body.subject,
      imageUrl,
      createdAt: Timestamp.now()

    });

    res.json({
      success: true,
      teacherId: docRef.id,
      imageUrl,
    });
  } catch (err) {
    console.error("Teacher upload error:", err);
    res
      .status(500)
      .json({ success: false, error: "Upload failed" });
  }
});


/* --------------------------------
   NEW: Teacher Request Endpoint (FIXED TO MATCH FRONTEND)
-------------------------------- */
router.post("/requestTeacher", upload.single("image"), async (req, res) => {
  try {
    let imageUrl = null;

    if (req.file && req.file.buffer) {
      const buffer = req.file.buffer;
      const contentType = req.file.mimetype || "image/jpeg";
      const ext = contentType.split("/")[1] || "jpg";
      const idBase = uuidv4();
      const filePath = `teachers_requests/${idBase}.${ext}`;

      const file = await uploadBufferToGCS(buffer, filePath, contentType);
      imageUrl = await getSignedUrl(file);
    }

    // ✅ CRITICAL ADDITION
    const studentEmail = req.body.studentEmail;

    if (!studentEmail) {
      return res.status(400).json({
        success: false,
        error: "Student email is required to make a request."
      });
    }

    const docRef = await firestore.collection("teacherRequests").add({
      subject: req.body.subject,
      topic: req.body.topic,
      gender: req.body.gender,
      imageUrl,

      // ✅ THIS UNBLOCKS ACCEPT REQUEST
      studentEmail,

      status: "pending",
      createdAt: Timestamp.now(),
    });

    res.json({
      success: true,
      requestId: docRef.id,
      imageUrl,
    });
  } catch (err) {
    console.error("Teacher request error:", err);
    res.status(500).json({ success: false, error: "Upload failed" });
  }
});


/* --------------------------------
   NEW: Get 3 Latest Teachers
-------------------------------- */
router.get("/teachers/random", async (req, res) => {
  try {
    const snapshot = await firestore
      .collection("teachers")
      .orderBy("createdAt", "desc")
      .limit(3)
      .get();

    const teachers = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, teachers });
  } catch (err) {
    console.error("Random teachers fetch error:", err);
    res.json({ success: false, teachers: [] });
  }
});

/* --------------------------------
   NEW: Get All Teacher Requests (WITH FILTERS)
-------------------------------- */
router.get("/getAllTeacherRequests", async (req, res) => {
  try {
    let query = firestore.collection("teacherRequests");

    // Read query parameters
    const { subject, gender } = req.query;

    // Apply filters conditionally
    if (subject) {
      query = query.where("subject", "==", subject);
    }

    if (gender) {
      query = query.where("gender", "==", gender);
    }
    
    // Always order and get the snapshot
    const snapshot = await query
      .orderBy("createdAt", "desc")
      .get();

    const requests = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      // Ensure createdAt is converted correctly if it exists
      createdAt: doc.data().createdAt ? doc.data().createdAt.toMillis() : null,
    }));

    res.json({ success: true, requests });
  } catch (err) {
    console.error("Fetch requests error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/* --------------------------------
   NEW: Get Count for Badge
-------------------------------- */
router.get("/requestCount", async (req, res) => {
  try {
    const snapshot = await firestore.collection("teacherRequests").get();
    const count = snapshot.size;
    res.json({ success: true, count });
  } catch (err) {
    console.error("Count error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});


/* --------------------------------
   NEW: Accept a Teacher Request (Accept Offer) - WITH SECURITY FIX
-------------------------------- */
// Apply the verifyIdToken middleware to this route
router.put("/acceptRequest/:requestId", verifyIdToken, async (req, res) => {
  try {
    const { requestId } = req.params;

    // --- CRITICAL FIX: Get teacher ID and email from the securely verified token ---
    const acceptedByTeacherId = req.user.uid;
    const acceptedByTeacherEmail = req.user.email; // Email is available in the decoded token
    // -----------------------------------------------------------------------------

    if (!acceptedByTeacherId || !acceptedByTeacherEmail) {
        // This should theoretically not be hit if verifyIdToken succeeds, but good for safety
        return res.status(401).json({ success: false, error: "Authenticated user ID or email missing." });
    }

    const requestRef = firestore.collection("teacherRequests").doc(requestId);
    const docSnap = await requestRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ success: false, error: "Request not found" });
    }

    const requestData = docSnap.data();
    // Assuming studentEmail is stored in the request document
    const studentEmail = requestData.studentEmail; 

    if (!studentEmail) {
        // Essential to have student email for meeting and notifications
        return res.status(400).json({ success: false, error: "Student email missing from request data." });
    }
    
  
   // const meetLink = await createMeetEvent(studentEmail, acceptedByTeacherEmail);//
   const meetLink = "https://meet.google.com/new"; // placeholder


    // 2. Update Firestore
    await requestRef.update({
      acceptedBy: acceptedByTeacherId, // Save the UID of the teacher
      status: "accepted",
      acceptedAt: Timestamp.now(),
      meetLink: meetLink, // Save the generated link
    });

    // 3. Send Notification Emails
    const subject = "✅ Ta-Da, your GoQuiz session is live!";
    const emailBody = `<p>Hi,</p><p>Your session is ready . click : <a href="${meetLink}">${meetLink}</a></p>`;

    // IMPORTANT: Ensure sendNotification matches this signature: (email, subject, body)
    await sendNotification(studentEmail, subject, emailBody);
    await sendNotification(acceptedByTeacherEmail, subject, emailBody);
    // -------------------------

    res.json({ success: true, message: `Request ${requestId} accepted.`, meetLink });

  } catch (err) {
    console.error("Accept request error:", err);
    res.status(500).json({ success: false, error: `Server error during processing: ${err.message}` });
  }
});

/* --------------------------------
   NEW: Post a Book (Sell my book)
   Captures poster email from verifyIdToken
-------------------------------- */
/* --------------------------------
   BOOKS: Post a Book (Sale)
-------------------------------- */
router.post("/postBook", verifyIdToken, upload.single("image"), async (req, res) => {
  try {
    // Matches HTML: <input name="phoneNumber">
    const { title, author, price, condition, location, phoneNumber } = req.body;
    let imageUrl = null;

    if (req.file && req.file.buffer) {
      const filePath = `books/${uuidv4()}_${req.file.originalname}`;
      const file = await uploadBufferToGCS(req.file.buffer, filePath, req.file.mimetype);
      imageUrl = await getSignedUrl(file);
    }

    const docRef = await firestore.collection("books").add({
      title, author, price, condition,
      location: location || "Unknown Location",
      posterPhone: phoneNumber || "Not provided", // Saved but hidden from catalogue
      imageUrl,
      posterEmail: req.user.email,
      posterUid: req.user.uid,
      status: "available",
      createdAt: Timestamp.now()
    });

    res.json({ success: true, bookId: docRef.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* --------------------------------
   BOOKS: Request a Book (Need)
-------------------------------- */
router.post("/requestBook", verifyIdToken, async (req, res) => {
  try {
    // Matches HTML: <input name="phoneNumber">
    const { title, author, notes, location, phoneNumber } = req.body;
    
    const docRef = await firestore.collection("bookRequests").add({
      title, author, notes,
      location: location || "Unknown Location",
      requesterPhone: phoneNumber || "Not provided", // Saved but hidden from catalogue
      requesterEmail: req.user.email,
      requesterUid: req.user.uid,
      status: "pending",
      createdAt: Timestamp.now()
    });

    res.json({ success: true, requestId: docRef.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* --------------------------------
   CATALOGUE: Fetch Data (Excludes Phone)
-------------------------------- */
router.get("/getAvailableBooks", async (req, res) => {
  try {
    const snapshot = await firestore.collection("books")
      .where("status", "==", "available").get(); 

    const books = snapshot.docs.map(doc => {
      const data = doc.data();
      // Remove posterPhone before sending to HTML
      const { posterPhone, ...publicData } = data; 
      return { id: doc.id, ...publicData, type: 'sale' };
    });
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/getBookRequests", async (req, res) => {
  try {
    const snapshot = await firestore.collection("bookRequests")
      .where("status", "==", "pending").get();

    const requests = snapshot.docs.map(doc => {
      const data = doc.data();
      // Remove requesterPhone before sending to HTML
      const { requesterPhone, ...publicData } = data;
      return { id: doc.id, ...publicData, type: 'request' };
    });
    res.json({ success: true, requests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* --------------------------------
   ACTIONS: Connect Users (Includes Phone)
-------------------------------- */
router.post("/acceptBook/:bookId", verifyIdToken, async (req, res) => {
  try {
    const { bookId } = req.params;
    // 'accepterPhone' comes from the Payment Modal input
    const { reference, accepterPhone } = req.body; 
    
    const buyerEmail = req.user.email;
    const bookRef = firestore.collection("books").doc(bookId);
    const doc = await bookRef.get();
    
    if (!doc.exists) return res.status(404).json({ error: "Book not found" });
    const bookData = doc.data();

    await bookRef.update({
      status: "accepted",
      acceptedByEmail: buyerEmail,
      acceptedByPhone: accepterPhone,
      paymentReference: reference || "Internal_OK",
      acceptedAt: Timestamp.now()
    });

    const subject = "📚 Contact Details Exchanged: Used Books Hub";
    const emailBody = `
      <h3>✅ Connection Successful!</h3>
      <p>A notification fee was paid to connect you for: <b>"${bookData.title}"</b>.</p>
      <hr>
      <h4>Seller Details:</h4>
      <p>Email: ${bookData.posterEmail}</p>
      <p>Phone: ${bookData.posterPhone}</p>
      <p>Location: ${bookData.location}</p>
      <br>
      <h4>Buyer Details:</h4>
      <p>Email: ${buyerEmail}</p>
      <p>Phone: ${accepterPhone}</p>
      <hr>
      <p>Please contact each other to finalize the delivery/pickup.</p>
    `;

    await sendNotification(bookData.posterEmail, subject, emailBody);
    await sendNotification(buyerEmail, subject, emailBody);

    res.json({ success: true, message: "Details sent to both users." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/fulfillRequest/:requestId", verifyIdToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reference, accepterPhone } = req.body; 
    
    // IMPORTANT: Verify Paystack here as discussed in previous steps
    // const isPaymentValid = await verifyPaystack(reference);
    // if (!isPaymentValid) return res.status(400).json({ error: "Invalid Payment" });

    const supplierEmail = req.user.email; // The person who HAS the book
    const requestRef = firestore.collection("bookRequests").doc(requestId);
    const doc = await requestRef.get();
    
    if (!doc.exists) return res.status(404).json({ error: "Request not found" });
    const requestData = doc.data();

    // Update the request status
    await requestRef.update({
      status: "fulfilled",
      fulfilledByEmail: supplierEmail,
      fulfilledByPhone: accepterPhone,
      paymentReference: reference,
      fulfilledAt: Timestamp.now()
    });

    const subject = "📖 Connection Made: Book Request Fulfilled";
    const emailBody = `
      <h3>✅ You've been connected!</h3>
      <p>A notification fee was paid to fulfill the request for: <b>"${requestData.title}"</b>.</p>
      <hr>
      <h4>Requester Details (Needs Book):</h4>
      <p>Email: ${requestData.requesterEmail}</p>
      <p>Phone: ${requestData.requesterPhone}</p>
      <p>Location: ${requestData.location}</p>
      <br>
      <h4>Supplier Details (Has Book):</h4>
      <p>Email: ${supplierEmail}</p>
      <p>Phone: ${accepterPhone}</p>
      <hr>
      <p>Please coordinate to get the book to the requester.</p>
    `;

    // Send to both parties
    await sendNotification(requestData.requesterEmail, subject, emailBody);
    await sendNotification(supplierEmail, subject, emailBody);

    res.json({ success: true, message: "Connection successful." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});


/** 
 * Step 1: Add this Helper to Verify with Paystack 
 */
async function verifyPaystack(reference) {
  try {
    const response = await fetch(`api.paystack.co{reference}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, // MUST be sk_live_...
      }
    });
    const data = await response.json();
    // Return true only if Paystack confirms success and amount matches N100 (10000 kobo)
    return data.status && data.data.status === "success" && data.data.amount === 10000;
  } catch (err) {
    console.error("Paystack Verification Error:", err);
    return false;
  }
}

/** 
 * Step 2: Update your acceptBook route 
 */
router.post("/acceptBook/:bookId", verifyIdToken, async (req, res) => {
  try {
    const { bookId } = req.params;
    const { reference, accepterPhone } = req.body; 
    
    // --- SECURITY: VERIFY PAYMENT BEFORE PROCEEDING ---
    const isPaymentValid = await verifyPaystack(reference);
    if (!isPaymentValid) {
      return res.status(400).json({ success: false, error: "Payment verification failed or invalid reference." });
    }

    const buyerEmail = req.user.email;
    const bookRef = firestore.collection("books").doc(bookId);
    const doc = await bookRef.get();
    
    if (!doc.exists) return res.status(404).json({ error: "Book not found" });
    const bookData = doc.data();

    // Prevent double-acceptance
    if (bookData.status === "accepted") {
        return res.status(400).json({ success: false, error: "This item has already been connected." });
    }

    await bookRef.update({
      status: "accepted",
      acceptedByEmail: buyerEmail,
      acceptedByPhone: accepterPhone,
      paymentReference: reference,
      acceptedAt: Timestamp.now()
    });

    const subject = "📚 Contact Details Exchanged: Used Books Hub";
    const emailBody = `
      <h3>✅ Connection Successful!</h3>
      <p>A notification fee was paid to connect you for: <b>"${bookData.title}"</b>.</p>
      <hr>
      <h4>Seller Details:</h4>
      <p>Email: ${bookData.posterEmail}</p>
      <p>Phone: ${bookData.posterPhone}</p>
      <p>Location: ${bookData.location}</p>
      <br>
      <h4>Buyer Details:</h4>
      <p>Email: ${buyerEmail}</p>
      <p>Phone: ${accepterPhone}</p>
      <hr>
      <p>Please contact each other to finalize the delivery/pickup.</p>
    `;

    // Send emails using your existing service
    await sendNotification(bookData.posterEmail, subject, emailBody);
    await sendNotification(buyerEmail, subject, emailBody);

    res.json({ success: true, message: "Details sent to both users." });
  } catch (err) {
    console.error("Server Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});









export default router;
