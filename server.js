import express from "express"
import multer from "multer"
import fs from "fs"
import mime from "mime"
import path from "path"
import { GoogleGenAI } from "@google/genai"

const app = express()
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024
  }
})

const apiKey = process.env.apikey

if (!apiKey) {
  console.error("missing apikey environment variable")
  process.exit(1)
}

const ai = new GoogleGenAI({ apiKey })

app.use(express.static("public"))

app.post("/edit", upload.array("images", 10), async (req, res) => {
  let files = []

  try {
    files = req.files || []
    const prompt = String(req.body?.prompt || "").trim()

    if (!prompt) {
      res.status(400).send("prompt is required")
      return
    }

    if (!files.length) {
      res.status(400).send("no images uploaded")
      return
    }

    const parts = [{ text: prompt }]

    for (const f of files) {
      if (!f?.path || !fs.existsSync(f.path)) continue

      const buffer = fs.readFileSync(f.path)
      if (!buffer.length) continue

      const mt =
        f.mimetype ||
        mime.getType(f.originalname) ||
        "application/octet-stream"

      parts.push({
        inlineData: {
          mimeType: mt,
          data: buffer.toString("base64")
        }
      })
    }

    if (parts.length < 2) {
      res.status(400).send("invalid image payload")
      return
    }

    const result = await ai.models.generateContent({
      model: "gemini-3-pro-image-preview",
      config: {
        responseModalities: ["image", "text"]
      },
      contents: [{ role: "user", parts }]
    })

    const outParts =
      result?.candidates?.[0]?.content?.parts || []

    const imagePart = outParts.find(
      p => p?.inlineData?.data
    )

    if (!imagePart) {
      const text = outParts
        .map(p => p.text)
        .filter(Boolean)
        .join("\n")

      res.status(502).send(text || "no image returned by model")
      return
    }

    const outputBuffer = Buffer.from(
      imagePart.inlineData.data,
      "base64"
    )

    res.setHeader(
      "content-type",
      imagePart.inlineData.mimeType || "image/png"
    )

    res.setHeader("cache-control", "no-store")
    res.send(outputBuffer)

  } catch (err) {
    res.status(500).send(String(err?.message || err))
  } finally {
    for (const f of files) {
      try {
        if (f?.path && fs.existsSync(f.path)) {
          fs.unlinkSync(f.path)
        }
      } catch {}
    }
  }
})

app.use((err, req, res, next) => {
  res.status(500).send("internal server error")
})

const port = process.env.PORT || 3000

app.listen(port, () => {
  console.log(`server running on port ${port}`)
})
