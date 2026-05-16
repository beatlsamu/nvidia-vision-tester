import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json({ limit: '50mb' }))

// ─── Proxy: /nvidia/* → integrate.api.nvidia.com ────────────────────────────
// The frontend calls /nvidia/v1/chat/completions with its own Bearer token.
// In production (Render), this Express route handles it instead of Vite proxy.
app.use('/nvidia', async (req, res) => {
  try {
    const url = `https://integrate.api.nvidia.com${req.path}`
    const response = await fetch(url, {
      method: req.method,
      headers: {
        'Authorization': req.headers['authorization'] || `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    })
    const text = await response.text()
    res.status(response.status).send(text)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Legacy /vision endpoint (kept for compatibility) ────────────────────────
app.post('/vision', async (req, res) => {
  try {
    const response = await fetch(process.env.VISION_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
    })
    const text = await response.text()
    res.send(text)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Serve React build (production) ─────────────────────────────────────────
const distPath = join(__dirname, 'dist')
if (existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get('*', (_, res) => res.sendFile(join(distPath, 'index.html')))
} else {
  app.get('/', (_, res) => res.send('Run `npm run build` first, or use `npm run dev`.'))
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`))
