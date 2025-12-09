const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ maxInstances: 10 });

exports.createTeachingRequest = onCall(async (req) => {
  const data = req.data;
  const auth = req.auth;

  if (!auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  const teachingRequest = {
    studentId: auth.uid,
    topic: data.topic,
    description: data.description || "",
    mode: data.mode || "instant",
    scheduledTime: data.scheduledTime || null,
    price: data.price || 0,
    status: "pending",
    teacherId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    pickedAt: null,
  };

  const docRef = await db.collection("teachingRequests").add(teachingRequest);

  return { id: docRef.id };
});
