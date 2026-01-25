// server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import cors from "cors";
import { ImageAnnotatorClient } from "@google-cloud/vision";

// Routes
import firebasePostsRouter from "./routes/firebasePosts.js";
import uploadRoutes from "./routes/upload.js";

// -------------------------------------------------------------------
// App initialization (MUST be first before usage)
// -------------------------------------------------------------------
const app = express();

// -------------------------------------------------------------------
// Path helpers
// -------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------------
// Middleware
// -------------------------------------------------------------------
app.use(cors());

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 🚫 Prevent Google from indexing APIs
app.use("/api", (req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});

// -------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------
app.use("/firebase-posts", firebasePostsRouter);
app.use("/api", uploadRoutes);

// ❌ Catch invalid API routes (must come AFTER real API routes)
app.all("/api/*", (req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.status(404).json({ error: "API endpoint not found" });
});

// Add this if you have a top-level /upload folder
app.use("/upload", (req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  next();
});


// -------------------------------------------------------------------
// Google Vision Initialization
// -------------------------------------------------------------------
let visionClient;

if (process.env.GOOGLE_CREDENTIALS_JSON) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    visionClient = new ImageAnnotatorClient({ credentials });
    console.log("✅ Vision client initialized with inline JSON");
  } catch (err) {
    console.error("❌ Invalid GOOGLE_CREDENTIALS_JSON", err);
    process.exit(1);
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  if (!fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    console.error("❌ Vision credentials file not found");
    process.exit(1);
  }
  visionClient = new ImageAnnotatorClient({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  });
  console.log("✅ Vision client initialized with key file");
} else {
  console.error("❌ No Google Vision credentials found");
  process.exit(1);
}

// -------------------------------------------------------------------
// OCR Endpoint
// -------------------------------------------------------------------
app.post("/api/ocr", async (req, res) => {
  if (!visionClient) {
    return res.status(500).json({ error: "Vision API unavailable" });
  }

  const { images } = req.body;
  if (!Array.isArray(images) || !images.length) {
    return res.status(400).json({ error: "No images provided" });
  }

  try {
    let fullText = "";

    const results = await Promise.all(
      images.map(img => {
        if (!img) return null;
        const clean = img.includes("base64,") ? img.split("base64,")[1] : img;
        return visionClient.textDetection({ image: { content: clean } });
      })
    );

    results.forEach(r => {
      if (!r) return;
      const [annotation] = r;
      fullText +=
        annotation.fullTextAnnotation?.text ||
        annotation.textAnnotations?.[0]?.description ||
        "";
      fullText += "\n\n";
    });

    if (!fullText.trim()) {
      return res.status(422).json({ error: "No readable text found" });
    }

    res.json({ text: fullText.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OCR failed" });
  }
});

// -------------------------------------------------------------------
// OpenAI Helper (FIXED)
// -------------------------------------------------------------------
async function callOpenAI(apiKey, messages, max_tokens = 500) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      max_tokens,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  }

  return response.json();
}

// -------------------------------------------------------------------
// Extract Endpoint
// -------------------------------------------------------------------
app.post("/api/extract", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });

  try {
    const data = await callOpenAI(process.env.EXTRACT_API_KEY, [
      { role: "system", content: "Convert this passage into clean readable text." },
      { role: "user", content: text },
    ], 600);

    res.json({
      extracted: data.choices?.[0]?.message?.content || "Extraction failed",
    });
  } catch (err) {
    res.status(500).json({ error: "Extract failed" });
  }
});

// -------------------------------------------------------------------
// Simplify Endpoint
// -------------------------------------------------------------------
app.post("/api/simplify", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });

  try {
    const data = await callOpenAI(process.env.SUMMARY_API_KEY, [
      { role: "system", content: "Simplify this for kids." },
      { role: "user", content: text },
    ], 500);

    res.json({
      simplified: data.choices?.[0]?.message?.content || "Simplification failed",
    });
  } catch {
    res.status(500).json({ error: "Simplify failed" });
  }
});

// -------------------------------------------------------------------
// Quiz Generator
// -------------------------------------------------------------------
app.post("/api/quiz", async (req, res) => {
  const { text, numQuestions } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });

  try {
    const data = await callOpenAI(process.env.QUIZ_API_KEY, [
      {
        role: "system",
        content:
          "Return ONLY valid JSON: {\"quiz\":[{\"question\":\"\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct\":0}]}",
      },
      {
        role: "user",
        content: `Create ${numQuestions || 5} questions from:\n${text}`,
      },
    ], 800);

    let quiz = [];
    try {
      quiz = JSON.parse(data.choices?.[0]?.message?.content || "{}").quiz || [];
    } catch {}

    res.json({ quiz });
  } catch {
    res.status(500).json({ error: "Quiz generation failed" });
  }
});

// -------------------------------------------------------------------
// ACCA Marking
// -------------------------------------------------------------------
app.post("/api/mark-acca", async (req, res) => {
  const { question, userAnswer, modelAnswer, maxScore = 20 } = req.body;
  if (!question || !userAnswer || !modelAnswer) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const data = await callOpenAI(process.env.SCORE_API_KEY, [
      {
        role: "system",
        content:
          "You are an ACCA marker. Return ONLY JSON {score,max_score,percentage,feedback}.",
      },
      {
        role: "user",
        content: `Q:${question}\nMODEL:${modelAnswer}\nSTUDENT:${userAnswer}\nMAX:${maxScore}`,
      },
    ], 800);

    res.json(JSON.parse(data.choices?.[0]?.message?.content || "{}"));
  } catch {
    res.status(500).json({ error: "Marking failed" });
  }
});

// GET /api/leaderboard?limit=50
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const snapshot = await admin.firestore().collection('users')
      .orderBy('userPoints', 'desc')
      .limit(limit)
      .get();

    const data = snapshot.docs.map(doc => ({
      uid: doc.id,
      name: doc.data().displayName || doc.data().email.split('@')[0], // Anonymize
      points: doc.data().userPoints || 0
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// -------------------------------------------------------------------
// Frontend fallback
// -------------------------------------------------------------------
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kids-app.html"));
});

// -------------------------------------------------------------------
// Start Server
// -------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
