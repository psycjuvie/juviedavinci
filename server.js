import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import mime from "mime";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";

const app = express();

const apiKey = process.env.apikey;
if (!apiKey) {
  console.error("missing apikey environment variable");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const MAX_PROMPT_CHARS = 4000;
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MODELS = {
  EDIT_PRO: "models/gemini-3-pro-image-preview",
  EDIT_NORMAL: "models/gemini-2.5-flash-image",
  TEXT: "models/gemini-3-pro-preview",
};

const IMAGE_MODELS = new Set([MODELS.EDIT_PRO, MODELS.EDIT_NORMAL]);

app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));
app.use(express.urlencoded({ extended: false, limit: "128kb" }));
app.use(express.static("public", { maxAge: "1h" }));

const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

const editLimiter = rateLimit({
  windowMs: 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
});

const textLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES },
  fileFilter: (req, file, cb) => {
    const ok = (file.mimetype || "").startsWith("image/");
    cb(ok ? null : new multer.MulterError("LIMIT_UNEXPECTED_FILE", "images"), ok);
  },
});

function clampPrompt(s) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > MAX_PROMPT_CHARS ? t.slice(0, MAX_PROMPT_CHARS) : t;
}

function partsToText(parts) {
  return (parts || [])
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { }
}

app.get("/healthz", (req, res) => res.json({ ok: true }));

app.post("/edit", editLimiter, upload.array("images", MAX_IMAGES), async (req, res, next) => {
  const files = req.files || [];
  try {
    const prompt = clampPrompt(req.body?.prompt);
    const mode = String(req.body?.mode || "").trim();
    const model = mode === "pro" ? MODELS.EDIT_PRO : MODELS.EDIT_NORMAL;

    if (!prompt) return res.status(400).send("prompt is required");
    if (!IMAGE_MODELS.has(model)) return res.status(400).send("invalid model");
    if (!files.length) return res.status(400).send("no images uploaded");

    const parts = [{ text: prompt }];

    for (const f of files) {
      if (!f?.path || !fs.existsSync(f.path)) continue;
      const buffer = fs.readFileSync(f.path);
      if (!buffer.length) continue;

      const mt = f.mimetype || mime.getType(f.originalname) || "application/octet-stream";
      parts.push({ inlineData: { mimeType: mt, data: buffer.toString("base64") } });
    }

    if (parts.length < 2) return res.status(400).send("invalid image payload");

    const config = {
      responseModalities: ["image", "text"],
      ...(model === MODELS.EDIT_PRO ? { imageConfig: { imageSize: "1K" } } : {}),
    };

    const result = await ai.models.generateContent({
      model,
      config,
      contents: [{ role: "user", parts }],
    });

    const outParts = result?.candidates?.[0]?.content?.parts || [];
    const imagePart = outParts.find((p) => p?.inlineData?.data);

    if (!imagePart) {
      const text = partsToText(outParts);
      return res.status(502).send(text || "no image returned by model");
    }

    const outputBuffer = Buffer.from(imagePart.inlineData.data, "base64");
    res.setHeader("content-type", imagePart.inlineData.mimeType || "image/png");
    res.setHeader("cache-control", "no-store");
    return res.send(outputBuffer);
  } catch (err) {
    next(err);
  } finally {
    for (const f of files) await safeUnlink(f?.path);
  }
});

app.post("/text", textLimiter, async (req, res, next) => {
  try {
    const prompt = clampPrompt(req.body?.prompt);
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const result = await ai.models.generateContent({
      model: MODELS.TEXT,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const outParts = result?.candidates?.[0]?.content?.parts || [];
    const txt = partsToText(outParts);
    return res.json({ text: txt || "" });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).send("image too large");
    if (err.code === "LIMIT_FILE_COUNT") return res.status(413).send("too many images");
    return res.status(400).send("invalid upload");
  }
  res.status(500).send(String(err?.message || "internal server error"));
});

const port = process.env.PORT ? Number(process.env.PORT) : 9999;
app.listen(port, () => console.log(`server running on port ${port}`));
