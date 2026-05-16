import React, { useState, useRef, useEffect, useCallback } from 'react'

const API_KEY = import.meta.env.VITE_NVIDIA_API_KEY
const MODEL = import.meta.env.VITE_MODEL
const API_URL = import.meta.env.VITE_API_URL

const SYSTEM_PROMPT = 'You are a computer vision AI. You ALWAYS respond with valid JSON only, no markdown, no explanation, no extra text.'

const DETECTION_PROMPT = `Analyze this image and return a JSON object with this exact structure:
{
  "scene_summary": "brief description in spanish",
  "objects": [
    {
      "label": "person",
      "color": "red shirt",
      "position": "left",
      "signature": "tall man with glasses",
      "confidence": 0.95
    }
  ]
}
List every visible object. Be specific with color and position to differentiate similar objects.`

const TRACKING_PROMPT = (targetLabel) => `You are tracking one specific object: "${targetLabel}".
Look carefully at the entire image. Is there a "${targetLabel}" visible anywhere?
Respond ONLY with this JSON, no extra text:
{
  "scene_summary": "one sentence in spanish",
  "objects": [],
  "target_present": true,
  "target_details": { "label": "${targetLabel}", "position": "left/center/right", "color": "..." }
}
Set target_present to true ONLY if you can clearly see the "${targetLabel}". If not visible, set it to false and target_details to null.`

function captureFrame(video, canvas) {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(video, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.7)
}

async function callNvidia(base64Image, promptText) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: base64Image } },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.1,
      top_p: 0.70,
    }),
  })
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  try { return JSON.parse(content) } catch { return { raw: content } }
}

export default function App() {
  const [tab, setTab] = useState('image')
  const [image, setImage] = useState(null)
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('detection')
  const [targetLabel, setTargetLabel] = useState('')
  const [selectedObject, setSelectedObject] = useState(null)

  // tracking state
  const [count, setCount] = useState(0)
  const [targetStatus, setTargetStatus] = useState(null) // null | 'present' | 'absent'
  const [alerts, setAlerts] = useState([]) // historial de eventos
  const prevPresentRef = useRef(null) // null = primera vez

  // camera
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const loopRef = useRef(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [framesSent, setFramesSent] = useState(0)
  const [latency, setLatency] = useState(0)
  const [intervalMs, setIntervalMs] = useState(500)

  function addAlert(type, msg) {
    const time = new Date().toLocaleTimeString()
    setAlerts(prev => [{ type, msg, time }, ...prev].slice(0, 20))
  }

  function speak(text: string) {
    if (!window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'es-ES'
    utter.rate = 1.1
    utter.pitch = 1.0
    window.speechSynthesis.speak(utter)
  }

  function processTrackingResult(result) {
    if (result?.target_present === undefined) return

    const isPresent = result.target_present
    const prev = prevPresentRef.current

    if (prev === null) {
      // primera detección
      if (isPresent) {
        setCount(1)
        setTargetStatus('present')
        addAlert('success', `✅ "${targetLabel}" detectado por primera vez`)
        speak(`${targetLabel}. 1`)
      } else {
        setTargetStatus('absent')
        addAlert('warning', `⚠️ "${targetLabel}" no visible al iniciar`)
      }
    } else if (!prev && isPresent) {
      // objeto reapareció → contar (solo habla aquí)
      setCount(c => {
        const next = c + 1
        addAlert('success', `✅ "${targetLabel}" reapareció — conteo: ${next}`)
        speak(`${next}`)
        return next
      })
      setTargetStatus('present')
    } else if (prev && !isPresent) {
      // objeto salió → silencio
      setTargetStatus('absent')
      addAlert('danger', `❌ "${targetLabel}" salió de la escena`)
    }

    prevPresentRef.current = isPresent
  }

  // image mode
  function handleImage(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setImage(file)
    setPreview(URL.createObjectURL(file))
    setResponse(null)
    setSelectedObject(null)
  }

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
    })
  }

  async function runOnImage(promptText) {
    if (!image) { setError('Sube una imagen.'); return }
    setLoading(true); setError(''); setResponse(null)
    try {
      const base64 = await toBase64(image)
      const result = await callNvidia(base64, promptText)
      setResponse(result)
      if (mode === 'tracking') processTrackingResult(result)
    } catch (err) {
      setError(err?.message || 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  // camera mode
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      })
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      setCameraActive(true)
      setFramesSent(0)
    } catch (err) {
      setError('No se pudo acceder a la cámara: ' + err.message)
    }
  }

  function stopCamera() {
    clearTimeout(loopRef.current)
    videoRef.current?.srcObject?.getTracks().forEach(t => t.stop())
    setCameraActive(false)
  }

  const runFrameLoop = useCallback(async () => {
    if (!cameraActive) return
    const frame = captureFrame(videoRef.current, canvasRef.current)
    if (frame) {
      const prompt = mode === 'tracking' && targetLabel
        ? TRACKING_PROMPT(targetLabel)
        : DETECTION_PROMPT
      const t0 = performance.now()
      try {
        const result = await callNvidia(frame, prompt)
        setLatency(Math.round(performance.now() - t0))
        setFramesSent(p => p + 1)
        setResponse(result)
        if (mode === 'tracking') processTrackingResult(result)
      } catch (err) {
        console.error(err)
      }
    }
    loopRef.current = setTimeout(runFrameLoop, intervalMs)
  }, [cameraActive, mode, targetLabel, intervalMs])

  useEffect(() => {
    if (cameraActive) {
      loopRef.current = setTimeout(runFrameLoop, intervalMs)
    }
    return () => clearTimeout(loopRef.current)
  }, [cameraActive, runFrameLoop, intervalMs])

  function handleDetect() {
    setMode('detection')
    setSelectedObject(null)
    setCount(0)
    setTargetStatus(null)
    setAlerts([])
    prevPresentRef.current = null
    if (tab === 'image') runOnImage(DETECTION_PROMPT)
  }

  function handleSelectObject(obj) {
    setSelectedObject(obj)
    setTargetLabel(obj.label)
    setMode('tracking')
    setCount(0)
    setTargetStatus(null)
    setAlerts([])
    prevPresentRef.current = null
  }

  function handleTrack() {
    if (!targetLabel) return
    if (tab === 'image') runOnImage(TRACKING_PROMPT(targetLabel))
  }

  const objects = response?.objects || []

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-7xl mx-auto">

        {/* HEADER */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">NVIDIA Vision Tester</h1>
          <p className="text-zinc-400">Multimodal image + camera testing interface</p>
        </div>

        {/* TABS */}
        <div className="flex gap-2 mb-6">
          {['image', 'camera'].map(t => (
            <button key={t}
              onClick={() => { setTab(t); setResponse(null); setError('') }}
              className={`px-5 py-2 rounded-2xl font-medium transition-all ${tab === t ? 'bg-white text-black' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            >
              {t === 'image' ? '🖼 Imagen' : '📷 Cámara'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* LEFT — INPUT */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6">

            {tab === 'image' && (
              <>
                <h2 className="text-lg font-semibold mb-4">Imagen</h2>
                <input type="file" accept="image/*" onChange={handleImage}
                  className="w-full bg-zinc-800 rounded-2xl p-3 mb-4 text-sm" />
                {preview && (
                  <img src={preview} alt="preview"
                    className="w-full rounded-2xl max-h-[250px] object-cover mb-4" />
                )}
              </>
            )}

            {tab === 'camera' && (
              <>
                <h2 className="text-lg font-semibold mb-4">Cámara</h2>
                <div className="relative mb-4 rounded-2xl overflow-hidden bg-zinc-800 aspect-video">
                  <video ref={videoRef} playsInline muted autoPlay className="w-full h-full object-cover" />
                  {!cameraActive && (
                    <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-sm">
                      Cámara apagada
                    </div>
                  )}
                </div>
                <canvas ref={canvasRef} className="hidden" />
                {cameraActive && (
                  <div className="flex gap-3 text-xs text-zinc-400 mb-2">
                    <span>Frames: <strong className="text-white">{framesSent}</strong></span>
                    <span>Lat: <strong className="text-white">{latency}ms</strong></span>
                    <span>Int: <strong className="text-white">{intervalMs}ms</strong></span>
                  </div>
                )}
                <div className="mb-4">
                  <div className="flex justify-between text-xs text-zinc-500 mb-1">
                    <span>⚡ Sensibilidad</span>
                    <span className={`font-medium ${intervalMs <= 400 ? 'text-green-400' : intervalMs <= 800 ? 'text-yellow-400' : 'text-zinc-400'}`}>
                      {intervalMs <= 400 ? 'Máxima' : intervalMs <= 800 ? 'Alta' : intervalMs <= 1500 ? 'Media' : 'Baja'} — {intervalMs}ms
                    </span>
                  </div>
                  <input
                    type="range" min="300" max="3000" step="100"
                    value={intervalMs}
                    onChange={e => setIntervalMs(Number(e.target.value))}
                    className="w-full accent-green-400"
                  />
                  <div className="flex justify-between text-xs text-zinc-700 mt-0.5">
                    <span>300ms</span>
                    <span>3s</span>
                  </div>
                </div>
                <button onClick={cameraActive ? stopCamera : startCamera}
                  className={`w-full py-3 rounded-2xl font-bold mb-4 text-sm ${cameraActive ? 'bg-red-600' : 'bg-white text-black'}`}>
                  {cameraActive ? '⏹ Detener cámara' : '▶ Iniciar cámara'}
                </button>
              </>
            )}

            {/* MODE */}
            <div className={`flex items-center gap-2 mb-4 px-3 py-2 rounded-2xl text-sm font-medium ${mode === 'detection' ? 'bg-blue-900/40 text-blue-300' : 'bg-green-900/40 text-green-300'}`}>
              {mode === 'detection' ? '🔍 Modo detección' : `🎯 Tracking: "${targetLabel}"`}
            </div>

            <button onClick={handleDetect}
              disabled={loading || (tab === 'image' && !image) || (tab === 'camera' && cameraActive)}
              className="w-full bg-white text-black py-3 rounded-2xl font-bold disabled:opacity-40 mb-3 text-sm">
              {loading && mode === 'detection' ? 'Detectando...' : '🔍 Detectar objetos'}
            </button>

            {selectedObject && (
              <button onClick={handleTrack}
                disabled={loading || (tab === 'image' && !image)}
                className="w-full bg-green-600 text-white py-3 rounded-2xl font-bold disabled:opacity-40 text-sm">
                {loading && mode === 'tracking' ? 'Analizando...' : `🎯 Analizar frame`}
              </button>
            )}

            {error && (
              <div className="mt-4 bg-red-950 border border-red-700 text-red-300 rounded-2xl p-3 text-sm">
                {error}
              </div>
            )}
          </div>

          {/* CENTER — OBJECTS + TRACKING */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6">

            {/* CONTADOR */}
            {mode === 'tracking' && (
              <div className="mb-5">
                <div className={`rounded-2xl p-5 text-center mb-3 border-2 transition-all ${
                  targetStatus === 'present' ? 'border-green-500 bg-green-900/20' :
                  targetStatus === 'absent'  ? 'border-red-600 bg-red-900/20' :
                  'border-zinc-700 bg-zinc-800/50'
                }`}>
                  <div className="text-5xl font-bold mb-1">{count}</div>
                  <div className="text-zinc-400 text-sm">apariciones de "{targetLabel}"</div>
                  <div className={`mt-2 text-sm font-medium ${
                    targetStatus === 'present' ? 'text-green-400' :
                    targetStatus === 'absent'  ? 'text-red-400' :
                    'text-zinc-500'
                  }`}>
                    {targetStatus === 'present' ? '✅ PRESENTE EN ESCENA' :
                     targetStatus === 'absent'  ? '❌ FUERA DE ESCENA' :
                     'Esperando análisis...'}
                  </div>
                </div>

                <button onClick={() => { setCount(0); setAlerts([]); prevPresentRef.current = null; setTargetStatus(null) }}
                  className="w-full py-2 rounded-xl text-xs text-zinc-500 border border-zinc-700 hover:border-zinc-500">
                  Resetear contador
                </button>
              </div>
            )}

            {/* OBJECTS LIST */}
            <h2 className="text-sm font-semibold text-zinc-400 mb-3">
              {mode === 'detection' ? 'Objetos detectados — elige uno para trackear:' : 'Último frame analizado:'}
            </h2>

            {objects.length > 0 ? (
              <div className="flex flex-col gap-2 max-h-[350px] overflow-auto">
                {objects.map((obj, i) => (
                  <button key={i} onClick={() => handleSelectObject(obj)}
                    className={`text-left px-4 py-3 rounded-2xl border transition-all ${
                      selectedObject?.label === obj.label && selectedObject?.color === obj.color
                        ? 'border-green-500 bg-green-900/30 text-green-300'
                        : 'border-zinc-700 bg-zinc-800 hover:border-white'
                    }`}>
                    <span className="font-medium">{obj.label}</span>
                    {obj.color && <span className="text-zinc-400 text-sm ml-2">· {obj.color}</span>}
                    {obj.position && <span className="text-zinc-500 text-sm ml-2">· {obj.position}</span>}
                    {obj.confidence && <span className="text-zinc-600 text-xs ml-2">{Math.round(obj.confidence * 100)}%</span>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-zinc-600 text-sm">
                {mode === 'detection' ? 'Detecta objetos para ver la lista' : 'Sin objetos en este frame'}
              </div>
            )}

            {response?.scene_summary && (
              <div className="mt-4 text-zinc-500 text-xs italic border-t border-zinc-800 pt-3">
                {response.scene_summary}
              </div>
            )}
          </div>

          {/* RIGHT — ALERTS */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Eventos</h2>
              <div className="text-xs text-zinc-500">{MODEL?.split('/')[1]}</div>
            </div>

            {alerts.length === 0 ? (
              <div className="text-zinc-600 text-sm">Sin eventos aún</div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[500px] overflow-auto">
                {alerts.map((a, i) => (
                  <div key={i} className={`px-3 py-2 rounded-xl text-sm border ${
                    a.type === 'success' ? 'border-green-800 bg-green-900/20 text-green-300' :
                    a.type === 'danger'  ? 'border-red-800 bg-red-900/20 text-red-300' :
                    'border-yellow-800 bg-yellow-900/20 text-yellow-300'
                  }`}>
                    <div>{a.msg}</div>
                    <div className="text-xs opacity-50 mt-1">{a.time}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
