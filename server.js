import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file
dotenv.config();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

let visionClient;

// --- GOOGLE VISION INITIALIZATION ---
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  // Inline JSON (for Render)
  try {
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    visionClient = new ImageAnnotatorClient({ credentials });
    console.log("✅ Vision client initialized with inline JSON");
  } catch (error) {
    console.error("❌ Error parsing GOOGLE_CREDENTIALS_JSON:", error);
    process.exit(1);
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  // File path (for local dev)
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

// === OCR ENDPOINT ===
app.post("/api/ocr", async (req, res) => {
  if (!visionClient) {
    console.error("❌ OCR request received but Vision client was not initialized.");
    return res.status(500).json({ error: "Vision API service unavailable." });
  }

  try {
    const { images } = req.body; // expects array of base64 strings
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "No images provided" });
    }

    console.log("📸 OCR request received. Image count:", images.length);

    let fullText = "";

    // Run OCR in parallel for speed
    const results = await Promise.all(
      images.map((img, idx) => {
        if (!img) {
          console.warn(`⚠️ Image at index ${idx} is empty or invalid`);
          return null;
        }

        // strip base64 prefix if included
        const cleanImg = img.includes("base64,") ? img.split("base64,")[1] : img;

        return visionClient
          .textDetection({ image: { content: cleanImg } })
          .catch(err => {
            console.error(`❌ Vision API error on image ${idx}:`, err.message);
            return null;
          });
      })
    );

    results.forEach((result, i) => {
      if (!result) {
        console.warn(`⚠️ Skipping image ${i}, no OCR result`);
        return;
      }
      const [annotation] = result;
      const text =
        annotation.fullTextAnnotation?.text ||
        (annotation.textAnnotations && annotation.textAnnotations[0]?.description) ||
        "";
      if (text) {
        console.log(`✅ OCR success for image ${i}, extracted length: ${text.length}`);
      } else {
        console.warn(`⚠️ No text found in image ${i}`);
      }
      fullText += text + "\n\n";
    });

    if (!fullText.trim()) {
      return res.status(422).json({ error: "No readable text found in images" });
    }

    res.json({ text: fullText.trim() });
  } catch (err) {
    console.error("❌ Unexpected OCR error:", JSON.stringify(err, null, 2));
    res.status(500).json({
      error: "OCR failed",
      details: err.message || err.toString(),
    });
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

// Fallback frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "kids-app.html"));
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});