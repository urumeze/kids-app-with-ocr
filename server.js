// server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import cors from "cors";

// Import the necessary route handlers
import firebasePostsRouter from "./routes/firebasePosts.js";
import uploadRoutes from "./routes/upload.js"; 



const app = express(); // 'app' is initialized before being used

app.use(cors());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Middleware ---
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Routes ---
app.use("/firebase-posts", firebasePostsRouter);


app.use("/api", uploadRoutes);




let visionClient;

// --- GOOGLE VISION INITIALIZATION ---
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    visionClient = new ImageAnnotatorClient({ credentials });
    console.log("✅ Vision client initialized with inline JSON");
  } catch (error) {
    console.error("❌ Error parsing GOOGLE_CREDENTIALS_JSON:", error);
    process.exit(1);
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    if (!fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      throw new Error("File not found: " + process.env.GOOGLE_APPLICATION_CREDENTIALS);
    }
    visionClient = new ImageAnnotatorClient({
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    });
    console.log("✅ Vision client initialized with key file path");
  } catch (error) {
    console.error("❌ Error using GOOGLE_APPLICATION_CREDENTIALS path:", error);
    process.exit(1);
  }
} else {
  console.error("❌ No Google credentials found");
  process.exit(1);
}

// --- OCR Endpoint ---
app.post("/api/ocr", async (req, res) => {
  if (!visionClient) return res.status(500).json({ error: "Vision API service unavailable." });

  try {
    const { images } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "No images provided" });
    }

    let fullText = "";
    const results = await Promise.all(
      images.map((img, idx) => {
        if (!img) return null;
        const cleanImg = img.includes("base64,") ? img.split("base64,") : img;
        return visionClient.textDetection({ image: { content: cleanImg } }).catch(() => null);
      })
    );

    results.forEach((result) => {
      if (!result) return;
      const [annotation] = result;
      // FIX APPLIED: Removed extra optional chaining '?.'.
      const text = annotation.fullTextAnnotation?.text || annotation.textAnnotations?.[0]?.description || "";
      fullText += text + "\n\n";
    });

    if (!fullText.trim()) return res.status(422).json({ error: "No readable text found" });
    res.json({ text: fullText.trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OCR failed", details: err.message });
  }
});

// --- OpenAI endpoints helper ---
async function callOpenAI(apiKey, messages, max_tokens = 500) {
  const response = await fetch("api.openai.com", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, max_tokens }),
  });
  return response.json();
}

// --- Extract Endpoint ---
app.post("/api/extract", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });
  try {
    const data = await callOpenAI(process.env.EXTRACT_API_KEY, [
      { role: "system", content: "Convert this passage into meaningful text easy to read." },
      { role: "user", content: text },
    ], 600);
    // FIX APPLIED: Removed extra optional chaining '?.'.
    res.json({ extracted: data.choices?.[0]?.message?.content || "Could not extract text." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Extract failed" });
  }
});

// --- Simplify Endpoint ---
app.post("/api/simplify", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });
  try {
    const data = await callOpenAI(process.env.SUMMARY_API_KEY, [
      { role: "system", content: "Simplify text for kids to understand." },
      { role: "user", content: text },
    ], 500);
    // FIX APPLIED: Removed extra optional chaining '?.'.
    res.json({ simplified: data.choices?.[0]?.message?.content || "Could not simplify." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Simplify failed" });
  }
});

// --- Quiz Endpoint ---
app.post("/api/quiz", async (req, res) => {
  const { text, numQuestions } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });

  try {
    const data = await callOpenAI(process.env.QUIZ_API_KEY, [
      {
        role: "system",
        content: "You are a kids quiz generator. Only return valid JSON in this format: {\"quiz\":[{\"question\":\"string\",\"options\":[\"A\",\"B\",\"C\",\"D\"],\"correct\":0}]}"
      },
      {
        role: "user",
        content: `Make ${numQuestions || 5} multiple-choice questions (4 options each) from this text:\n\n${text}`
      }
    ], 800);

    let quiz = [];
    try {
      // FIX APPLIED: Removed extra optional chaining '?.'.
      quiz = JSON.parse(data.choices?.[0]?.message?.content || "{}").quiz || [];
    } catch {}
    if (!quiz.length) quiz = [{ question: "Fallback question?", options: ["A","B","C","D"], correct: 0 }];
    res.json({ quiz });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Quiz failed" });
  }
});

// --- Score Endpoint ---
app.post("/api/score", async (req, res) => {
  const { question, userAnswer } = req.body;
  if (!question || !userAnswer) return res.status(400).json({ error: "Missing inputs" });

  try {
    const data = await callOpenAI(process.env.SCORE_API_KEY, [
      { role: "system", content: "You are a quiz grader. Reply only with JSON {\"correct\": true/false}." },
      { role: "user", content: `Question: ${question}\nStudent Answer: ${userAnswer}` }
    ], 100);

    let result = { correct: false };
    try { 
      // FIX APPLIED: Removed extra optional chaining '?.'.
      result = JSON.parse(data.choices?.[0]?.message?.content || "{}"); 
    } catch {}
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Score failed" });
  }
});

// --- ACCA Marking Endpoint ---
app.post("/api/mark-acca", async (req, res) => {
  const { question, userAnswer, modelAnswer, maxScore } = req.body;
  if (!question || !userAnswer || !modelAnswer) return res.status(400).json({ error: "Missing required fields" });

  try {
    const data = await callOpenAI(process.env.SCORE_API_KEY, [
      {
        role: "system",
        content: `
You are an ACCA exam marker. Score using official marking style.
Return ONLY JSON like:
{"score": number,"max_score": number,"percentage": number,"feedback": "text feedback"}
Mark fairly, deduct missing points or errors.
max_score = ${maxScore || 20}`
      },
      {
        role: "user",
        content: `
QUESTION:
${question}

MODEL ANSWER:
${modelAnswer}

STUDENT ANSWER:
${userAnswer}

max_score = ${maxScore || 20}`
      }
    ], 800);

    let result = {};
    try { 
      // FIX APPLIED: Removed extra optional chaining '?.'.
      result = JSON.parse(data.choices?.[0]?.message?.content || "{}"); 
    } catch {}
    if (!result.score) result = { score: 0, max_score: maxScore || 20, percentage: 0, feedback: "Automatic marking failed." };
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Marking failed" });
  }
});

// --- Fallback frontend ---
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kids-app.html"));
});

// --- Start server ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
