// routes/upload.js
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { Timestamp } from "firebase-admin/firestore";
import { initUser } from "../utils/initUser.js";
import { FieldValue } from "firebase-admin/firestore";



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

    // ✅ CREATE USER WALLET ON FIRST REQUEST
    await initUser(decodedToken.uid, decodedToken.email);

    req.user = decodedToken;
    console.log("✅ Wallet checked/created for:", decodedToken.uid);

    next();
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
   Updated Teacher Upload Endpoint (WITH OAUTH EMAIL)
-------------------------------- */
// Added 'verifyIdToken' middleware to this route
router.post("/teacher", verifyIdToken, upload.single("image"), async (req, res) => {
  try {
    // 1. Get email from the verified token (attached to req.user by middleware)
    const teacherEmail = req.user.email; 

    // 2. Destructure other fields from body
    const { name, gender, subject, phone } = req.body;

    // 3. Validation
    if (!name || !gender || !subject || !phone || !req.file) {
      return res.status(400).json({ success: false, error: "Missing required fields or image" });
    }

    const buffer = req.file.buffer;
    const contentType = req.file.mimetype;
    const ext = contentType.split("/")[1];
    const filePath = `teachers/${uuidv4()}.${ext}`;

    // 4. Upload to GCS
    const file = await uploadBufferToGCS(buffer, filePath, contentType);
    
    // Fix: Using backticks for the variable template
    const imageUrl = `storage.googleapis.com{bucket.name}/${filePath}`;

    // 5. Save to Firestore including the OAuth email
    const docRef = await firestore.collection("teachers").add({
      name,
      gender,
      subject,
      phone,
      teacherEmail, // <--- Fetched from OAuth via verifyIdToken middleware
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
    res.status(500).json({ success: false, error: "Upload failed" });
  }
});

// GET route to fetch all teacher profiles
router.get("/teachers", async (req, res) => {
  try {
    const snapshot = await firestore.collection("teachers").orderBy("createdAt", "desc").get();
    
    // Map the documents into an array of objects
    const teachers = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, data: teachers });
  } catch (err) {
    console.error("Error fetching teachers:", err);
    res.status(500).json({ success: false, error: "Failed to fetch profiles" });
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

    const docRef = await firestore.collection("teachers").add({
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

// GET route to fetch all teacher profiles (Mirroring your Books logic)
router.get("/teachers", async (req, res) => {
  try {
    // Fetches the 'teachers' collection, sorted by newest first
    const snapshot = await firestore.collection("teachers")
                                    .orderBy("createdAt", "desc")
                                    .get();
    
    // Maps the Firestore documents into a clean array
    const teachers = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Returns a response structure consistent with your Books feature
    res.json({ success: true, data: teachers });
  } catch (err) {
    console.error("Error fetching teachers:", err);
    res.status(500).json({ success: false, error: "Failed to fetch profiles" });
  }
});

// --- Add this to the bottom of routes/upload.js ---

router.post('/contactTeacher/:id', async (req, res) => {
    const teacherId = req.params.id;
    const { reference, accepterPhone } = req.body;

    try {
        // Log for verification (You can add Paystack verification logic here later)
        console.log(`✅ Teacher Contact Request: ID ${teacherId}, Phone: ${accepterPhone}, Ref: ${reference}`);

        // Return success so the frontend knows the transaction is finished
        res.status(200).json({ 
            success: true, 
            message: "Connection successful. Teacher details will be sent shortly." 
        });
    } catch (error) {
        console.error("Backend Teacher Route Error:", error);
        res.status(500).json({ success: false, error: "Server failed to process contact request." });
    }
});


    
/* ---------------------------------------------------------
   CORRECTED: Fulfill Teacher Request
--------------------------------------------------------- */
router.post("/acceptRequestWithWallet/:requestId", verifyIdToken, async (req, res) => {
  const { requestId } = req.params;
  const { accepterPhone } = req.body;
  const userUid = req.user.uid;
  const teacherEmail = req.user.email;
  const COST = 5;

  try {
    const userRef = firestore.collection("users").doc(userUid);
    const requestRef = firestore.collection("teachers").doc(requestId);

    const result = await firestore.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const requestDoc = await t.get(requestRef);

      if (!requestDoc.exists) throw new Error("Teacher request not found.");
      if (!userDoc.exists) throw new Error("User wallet not found.");

      const userData = userDoc.data();
      const requestData = requestDoc.data();

      if ((userData.coinBalance || 0) < COST) {
        throw new Error("Insufficient Gocoins. Please top up.");
      }

      if (requestData.status === "fulfilled") {
        throw new Error("This request has already been fulfilled.");
      }

      const newBalance = userData.coinBalance - COST;

      // Atomic Updates
      t.update(userRef, { coinBalance: newBalance });
      t.update(requestRef, {
        status: "fulfilled",
        fulfilledByEmail: teacherEmail,
        fulfilledByPhone: accepterPhone,
        fulfilledAt: Timestamp.now()
      });

      return { requestData, newBalance };
    });

    // --- FIX: Recipient Email Safety ---
    const studentEmail = result.requestData.studentEmail || result.requestData.email;
    const subject = "🎓 Connection Made: Teacher Request Fulfilled";
    const emailBody = `<h3>✅ Connection Successful!</h3>
      <p>Request: <b>"${result.requestData.subject || 'Teacher Request'}"</b></p>
      <p>Teacher Email: ${teacherEmail}</p>
      <p>Teacher Phone: ${accepterPhone}</p>`;

    // Only send if the recipient email exists
    if (studentEmail) {
      await sendNotification(studentEmail, subject, emailBody);
      await sendNotification(teacherEmail, subject, emailBody);
    } else {
      console.warn("Notification skipped: No student email found in request data.");
    }

    res.json({ 
      success: true, 
      newBalance: result.newBalance,
      message: "Details sent successfully." 
    });

  } catch (err) {
    console.error("Wallet Fulfillment Error:", err.message);
    res.status(400).json({ success: false, error: err.message });
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

    const requestRef = firestore.collection("teacher").doc(requestId);
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
   BOOKS: Post a Book (Sale)
-------------------------------- */
router.post("/postBook", verifyIdToken, upload.array("images"), async (req, res) => {
  try {
    // Location and Phone Number are single values from the global inputs
    const { location, phoneNumber } = req.body;
    
    // The book details (title, author, etc.) will be arrays due to the HTML structure
    const titles = req.body.title;
    const authors = req.body.author;
    const prices = req.body.price;
    const conditions = req.body.condition;
    
    // req.files is an array of uploaded image objects
    const files = req.files || [];

    const postedBooks = [];
    const booksCount = titles ? titles.length : 0;

    // Loop through each submitted book
    for (let i = 0; i < booksCount; i++) {
      const bookData = {
        title: titles?.[i] || "",
        author: authors?.[i] || "",
        price: prices?.[i] ? Number(prices[i]) : 0, // ✅ NEVER undefined
        condition: conditions?.[i] || "Not specified",
        location: location || "Unknown Location",
        posterPhone: phoneNumber || "Not provided",
        posterEmail: req.user.email,
        posterUid: req.user.uid,
        status: "available",
        createdAt: Timestamp.now()
      };

      // Handle the corresponding image upload for this specific book index 'i'
      if (files[i] && files[i].buffer) {
        const filePath = `books/${uuidv4()}_${files[i].originalname}`;
        const uploadedFile = await uploadBufferToGCS(files[i].buffer, filePath, files[i].mimetype);
        bookData.imageUrl = await getSignedUrl(uploadedFile);
      }

      // Add the book data to Firestore
      const docRef = await firestore.collection("books").add(bookData);
      postedBooks.push({ bookId: docRef.id, title: bookData.title });
    }

    res.json({ success: true, count: postedBooks.length, books: postedBooks });

  } catch (err) {
    console.error("Error posting books:", err);
    res.status(500).json({ success: false, error: "Failed to post books. " + err.message });
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

/* ---------------------------------------------------------
   NEW: Fulfill Book Request via Wallet (Replaces Paystack)
--------------------------------------------------------- */
router.post("/fulfillRequestWithWallet/:requestId", verifyIdToken, async (req, res) => {
  const { requestId } = req.params;
  const { accepterPhone } = req.body; // Supplier's phone
  const userUid = req.user.uid;
  const supplierEmail = req.user.email;
  const COST = 5; // Cost in Gocoins

  try {
    const userRef = firestore.collection("users").doc(userUid);
    const requestRef = firestore.collection("bookRequests").doc(requestId);

    const result = await firestore.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const requestDoc = await t.get(requestRef);

      // 1. Existence Checks
      if (!requestDoc.exists) throw new Error("Book request not found.");
      if (!userDoc.exists) throw new Error("User wallet not found.");

      const userData = userDoc.data();
      const requestData = requestDoc.data();

      // 2. Check Balance
      if ((userData.coinBalance || 0) < COST) {
        throw new Error("Insufficient Gocoins. Please top up your wallet.");
      }

      // 3. Prevent double-fulfillment
      if (requestData.status === "fulfilled") {
        throw new Error("This request has already been fulfilled by someone else.");
      }

      // 4. Deduct Coins & Update Request
      const newBalance = userData.coinBalance - COST;
      t.update(userRef, { coinBalance: newBalance });
      t.update(requestRef, {
        status: "fulfilled",
        fulfilledByEmail: supplierEmail,
        fulfilledByPhone: accepterPhone,
        fulfilledAt: Timestamp.now()
      });

      return { requestData, newBalance };
    });

    // 5. Send Notification Emails
    const subject = "📖 Connection Made: Book Request Fulfilled";
    const emailBody = `
      <h3>✅ Connection Successful!</h3>
      <p>A supplier used <b>${COST} Gocoins</b> to fulfill the request for: <b>"${result.requestData.title}"</b>.</p>
      <hr>
      <h4>Requester Details:</h4>
      <p>Email: ${result.requestData.requesterEmail}</p>
      <p>Phone: ${result.requestData.requesterPhone}</p>
      <br>
      <h4>Supplier Details (You):</h4>
      <p>Email: ${supplierEmail}</p>
      <p>Phone: ${accepterPhone}</p>
      <hr>
      <p>Please coordinate to deliver the book.</p>
    `;

    await sendNotification(result.requestData.requesterEmail, subject, emailBody);
    await sendNotification(supplierEmail, subject, emailBody);

    res.json({ 
      success: true, 
      message: "Connection successful. Gocoins deducted.",
      newBalance: result.newBalance 
    });

  } catch (err) {
    console.error("Wallet Fulfill Error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});

/** 
 * Step 1: Add this Helper to Verify with Paystack 
 */
// routes/upload.js (or similar)
async function verifyPaystack(reference, expectedAmountNaira) {
  try {
    // FIX: Corrected URL structure with protocol and path
    const url = `api.paystack.co{reference}`;
    
    const response = await fetch(url, {
      method: "GET",
      headers: {
        // Ensure this secret key is set in your 2026 environment variables
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      }
    });
    
    const result = await response.json();
    
    // Paystack uses kobo (subunit); 100 Naira = 10000 kobo
    const expectedKobo = expectedAmountNaira * 100;

    // 2026 Best Practice: Verify API status, transaction status, AND amount
    return (
      result.status === true && 
      result.data.status === "success" && 
      result.data.amount === expectedKobo
    );
  } catch (err) {
    console.error("Paystack Verification Error:", err);
    return false;
  }
}


/** 
 * Step 2: Update your acceptBook route 
 */
router.post("/acceptBookWithWallet/:bookId", verifyIdToken, async (req, res) => {
  const { bookId } = req.params;
  const { accepterPhone } = req.body;
  const userUid = req.user.uid;
  const COST = 5; // Cost in Gocoins

  try {
    const userRef = firestore.collection("users").doc(userUid);
    const bookRef = firestore.collection("books").doc(bookId);

    // --- CRITICAL: Atomic Transaction ---
    const result = await firestore.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const bookDoc = await t.get(bookRef);

      if (!userDoc.exists) throw new Error("User wallet not found.");
      if (!bookDoc.exists) throw new Error("Book not found.");

      const userData = userDoc.data();
      const bookData = bookDoc.data();

      // 1. Check if user has enough coins
      if ((userData.coinBalance || 0) < COST) {
        throw new Error("Insufficient Gocoins. Please top up.");
      }

      // 2. Check if book is still available
      if (bookData.status === "accepted") {
        throw new Error("This book has already been connected to another buyer.");
      }

      // 3. Deduct coins from user
      const newBalance = userData.coinBalance - COST;
      t.update(userRef, { coinBalance: newBalance });

      // 4. Mark book as accepted
      t.update(bookRef, {
        status: "accepted",
        acceptedByEmail: req.user.email,
        acceptedByPhone: accepterPhone,
        acceptedAt: Timestamp.now()
      });

      return { bookData, newBalance };
    });

    // --- Send Notifications ---
    const subject = "📚 Contact Details Exchanged: Used Books Hub";
    const emailBody = `
      <h3>✅ Connection Successful!</h3>
      <p> Hurray!!! Contacts exchanged for: <b>"${result.bookData.title}"</b>.</p>
      <p>Let's make it official </p>
      <hr>
      <h4>Seller Details:</h4>
      <p>Email: ${result.bookData.posterEmail}</p>
      <p>Phone: ${result.bookData.posterPhone}</p>
      <br>
      <h4>Buyer Details:</h4>
      <p>Email: ${req.user.email}</p>
      <p>Phone: ${accepterPhone}</p>
    `;

    await sendNotification(result.bookData.posterEmail, subject, emailBody);
    await sendNotification(req.user.email, subject, emailBody);

    // Return the new balance so the frontend UI updates instantly
    res.json({ success: true, newBalance: result.newBalance });

  } catch (err) {
    console.error("Wallet Accept Error:", err);
    res.status(400).json({ success: false, error: err.message });
  }
});


router.post("/buyGocoins", verifyIdToken, async (req, res) => {
  const { reference, amountInNaira } = req.body;

  // 1. Verify payment with your existing helper
  const isValid = await verifyPaystack(reference);
  if (!isValid) return res.status(400).json({ error: "Invalid transaction" });

  // 2. Determine coin amount (e.g., ₦100 = 10 Gocoins)
  const coinsToCredit = (amountInNaira / 100) * 10;

  const userRef = firestore.collection("users").doc(req.user.uid);
  await userRef.update({
    coinBalance: FieldValue.increment(coinsToCredit)
  });

  res.json({ success: true, credited: coinsToCredit });
});


// POST /api/topupWallet
router.post("/topupWallet", verifyIdToken, async (req, res) => {
  const { reference, amountInNaira } = req.body;
  const userUid = req.user.uid;

  if (!reference || !amountInNaira) {
    return res.status(400).json({ success: false, error: "Missing reference or amount." });
  }

  try {
    // 1. Verify payment with Paystack
    const isPaymentValid = await verifyPaystack(reference);
    if (!isPaymentValid) {
      return res.status(400).json({ success: false, error: "Payment verification failed." });
    }

    // 2. Calculate coins (e.g., ₦100 = 10 Gocoins)
    const coinsToAdd = (amountInNaira / 100) * 10;

    // 3. Atomically increment the user's balance
    const userRef = firestore.collection("users").doc(userUid);
    await userRef.update({
      coinBalance: FieldValue.increment(coinsToAdd),
      lastTopUpAt: Timestamp.now(),
      lastTopUpRef: reference
    });

    // 4. Fetch the updated balance to return to the frontend
    const updatedSnap = await userRef.get();
    const newBalance = updatedSnap.data().coinBalance;

    res.json({ 
      success: true, 
      message: `Successfully credited ${coinsToAdd} Gocoins.`,
      newBalance: newBalance 
    });

  } catch (err) {
    console.error("Top-up Error:", err);
    res.status(500).json({ success: false, error: "Internal server error during top-up." });
  }
});

router.post("/acceptBookWithWallet/:bookId", verifyIdToken, async (req, res) => {
  const { bookId } = req.params;
  const { accepterPhone } = req.body;
  const userUid = req.user.uid;
  const COST = 5;

  try {
    const userRef = firestore.collection("users").doc(userUid);
    const bookRef = firestore.collection("books").doc(bookId);

    const result = await firestore.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const bookDoc = await t.get(bookRef);

      if (!bookDoc.exists) throw new Error("Book not found.");
      if ((userDoc.data().coinBalance || 0) < COST) throw new Error("Insufficient Gocoins.");

      const newBalance = userDoc.data().coinBalance - COST;
      t.update(userRef, { coinBalance: newBalance });
      t.update(bookRef, { 
        status: "accepted", 
        acceptedByEmail: req.user.email,
        acceptedByPhone: accepterPhone 
      });

      return { bookData: bookDoc.data(), newBalance };
    });

    // Notification Logic...
    res.json({ success: true, newBalance: result.newBalance });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});



router.post("/wallet/topup", verifyIdToken, async (req, res) => {
  try {
    const { reference } = req.body;
    const uid = req.user.uid;

    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const paystackData = await paystackRes.json();

    if (!paystackData.status || paystackData.data.status !== "success") {
      return res.status(400).json({ success: false, error: "Payment verification failed." });
    }

    // 🔒 Amount → Coins mapping
    const amount = paystackData.data.amount; // kobo
    let coins = 0;

    if (amount === 100000) coins = 100;
    else if (amount === 200000) coins = 250;
    else if (amount === 400000) coins = 500;
    else {
      return res.status(400).json({ success: false, error: "Invalid payment amount." });
    }

    const userRef = firestore.collection("users").doc(uid);
    await userRef.update({
      coinBalance: FieldValue.increment(coins)
    });

    const snap = await userRef.get();

    res.json({
      success: true,
      newBalance: snap.data().coinBalance
    });

  } catch (err) {
    console.error("Top-up Error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

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





















