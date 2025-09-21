import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import vision from "@google-cloud/vision";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// === Google Vision Client ===
// Uses GOOGLE_APPLICATION_CREDENTIALS from .env automatically
const vision = require('@google-cloud/vision'); // Ensure this is at the top of your file

let visionClient; // Declare visionClient at a scope accessible by the OCR endpoint

// --- VISION CLIENT INITIALIZATION ---
// This block should run once when your application starts
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    visionClient = new vision.ImageAnnotatorClient({ credentials });
    console.log("✅ Google Cloud Vision client initialized with explicit credentials.");
  } catch (error) {
    console.error("❌ Error parsing GOOGLE_CREDENTIALS_JSON environment variable:", error);
    // It's critical to have valid credentials, so exiting is often a good strategy
    // if the app cannot function without Vision API.
    process.exit(1);
  }
} else {
  console.error("❌ GOOGLE_CREDENTIALS_JSON environment variable not found. " +
                "Vision API will not work. Please set it on Render.");
  process.exit(1); // Exit as Vision API is a core feature
}


// === OCR ENDPOINT ===
app.post("/api/ocr", async (req, res) => {
  // Add an additional check here in case initialization somehow failed (e.g., if you remove the process.exit calls)
  if (!visionClient) {
    console.error("❌ OCR request received but Vision client was not initialized.");
    return res.status(500).json({ error: "Vision API service unavailable due to initialization failure." });
  }

  try {
    const { image } = req.body;
    if (!image) {
      console.error("❌ No image received in request");
      return res.status(400).json({ error: "No image provided" });
    }

    console.log("📷 Received image, length:", image.length);

    // This line will now use the properly initialized visionClient
    const [result] = await visionClient.textDetection({ image: { content: image } });

    const text =
      result.fullTextAnnotation?.text ||
      (result.textAnnotations && result.textAnnotations[0]?.description) ||
      "";

    res.json({ text });
  } catch (err) {
    console.error("❌ OCR error:", err);
    // Make sure to include err.message for clearer debugging
    res.status(500).json({ error: "OCR failed", details: err.message });
  }
});

// === 1. EXTRACT ENDPOINT ===
app.post("/api/extract", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.EXTRACT_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "convert this passage into meaningful text easy to read please" },
          { role: "user", content: text },
        ],
        max_tokens: 600,
      }),
    });

    const data = await response.json();
    const extracted = data.choices?.[0]?.message?.content || "Could not extract text.";
    res.json({ extracted });
  } catch (err) {
    console.error("Extract error:", err);
    res.status(500).json({ error: "Extract failed" });
  }
});

// === 2. SIMPLIFY ENDPOINT ===
app.post("/api/simplify", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SUMMARY_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Simplify text for kids to understand." },
          { role: "user", content: text },
        ],
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    const simplified = data.choices?.[0]?.message?.content || "Could not simplify.";
    res.json({ simplified });
  } catch (err) {
    console.error("Simplify error:", err);
    res.status(500).json({ error: "Simplify failed" });
  }
});

// === 3. QUIZ ENDPOINT ===
app.post("/api/quiz", async (req, res) => {
  try {
    const { text, numQuestions } = req.body;
    if (!text) return res.status(400).json({ error: "Missing text" });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.QUIZ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a kids quiz generator. Only return valid JSON in this format:\n{\n  \"quiz\": [\n    { \"question\": \"string\", \"options\": [\"A\",\"B\",\"C\",\"D\"], \"correct\": 0 }\n  ]\n}",
          },
          {
            role: "user",
            content: `Make ${numQuestions || 5} multiple-choice questions (4 options each, one correct) from this text:\n\n${text}`,
          },
        ],
        max_tokens: 800,
        response_format: { type: "json_object" },
      }),
    });

    const data = await response.json();
    let quiz = [];

    try {
      quiz = JSON.parse(data.choices?.[0]?.message?.content || "{}").quiz || [];
    } catch (e) {
      console.error("Quiz parse error:", e);
    }

    if (!Array.isArray(quiz) || quiz.length === 0) {
      return res.json({
        quiz: [
          {
            question: "Fallback question?",
            options: ["Option A", "Option B", "Option C", "Option D"],
            correct: 0,
          },
        ],
      });
    }

    res.json({ quiz });
  } catch (err) {
    console.error("Quiz error:", err);
    res.status(500).json({ error: "Quiz failed" });
  }
});

// === 4. SCORE ENDPOINT ===
app.post("/api/score", async (req, res) => {
  try {
    const { question, userAnswer } = req.body;
    if (!question || !userAnswer) return res.status(400).json({ error: "Missing inputs" });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SCORE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a quiz grader. Reply only with JSON {\"correct\": true/false}." },
          { role: "user", content: `Question: ${question}\nStudent Answer: ${userAnswer}` },
        ],
        max_tokens: 100,
        response_format: { type: "json_object" },
      }),
    });

    const data = await response.json();
    let result = { correct: false };

    try {
      result = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    } catch (e) {
      console.error("Score parse error:", e);
    }

    res.json(result);
  } catch (err) {
    console.error("Score error:", err);
    res.status(500).json({ error: "Score failed" });
  }
});

// Fallback: frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kids-app.html"));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
