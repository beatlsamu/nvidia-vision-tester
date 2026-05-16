# NVIDIA Vision Tester

Multimodal vision testing interface powered by NVIDIA NIM + Llama 4 Maverick.

## Local dev

```bash
npm install
npm run dev        # Vite dev server with proxy → opens on localhost:5173
```

## Deploy to Render

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/TU_USUARIO/nvidia-vision-tester.git
git push -u origin main
```

### 2. Create Web Service on Render
- Go to https://render.com → New → Web Service
- Connect your GitHub repo
- Settings:
  - **Runtime:** Node
  - **Build Command:** `npm install && npm run build`
  - **Start Command:** `node server.js`

### 3. Add Environment Variables in Render dashboard
| Key | Value |
|-----|-------|
| `NVIDIA_API_KEY` | `nvapi-PKxYVtcqQYJU3n0nXDdnJBuPQ8z3-...` |
| `VITE_NVIDIA_API_KEY` | same value |
| `VITE_MODEL` | `meta/llama-4-maverick-17b-128e-instruct` |
| `VITE_API_URL` | `/nvidia/v1/chat/completions` |

> ⚠️ `VITE_*` vars are embedded in the frontend bundle. For a personal/testing tool this is fine.
> For production with sensitive keys, use only the server-side `NVIDIA_API_KEY` and remove the client-side auth header.

### 4. Deploy
Render builds and deploys automatically. Your app will be live at `https://nvidia-vision-tester.onrender.com`.

## Architecture

```
Browser → /nvidia/v1/chat/completions
            ↓
        Express (server.js)          ← Production
            ↓
        integrate.api.nvidia.com

Browser → /nvidia/v1/chat/completions
            ↓
        Vite Proxy (dev only)        ← Local dev
            ↓
        integrate.api.nvidia.com
```

No CORS issues. No ngrok needed. Single Render service.
