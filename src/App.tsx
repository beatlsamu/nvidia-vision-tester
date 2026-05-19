import React, { useState, useRef, useEffect } from 'react'

const API_KEY = import.meta.env.VITE_NVIDIA_API_KEY
const MODEL   = import.meta.env.VITE_MODEL
const API_URL = import.meta.env.VITE_API_URL

// ── DETECTION / TRACKING ──────────────────────────────────────────────────────
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

const TRACKING_PROMPT = (targetLabel: string) =>
  `You are tracking one specific object: "${targetLabel}".
Look carefully at the entire image. Is there a "${targetLabel}" visible anywhere?
Respond ONLY with this JSON, no extra text:
{
  "scene_summary": "one sentence in spanish",
  "objects": [],
  "target_present": true,
  "target_details": { "label": "${targetLabel}", "position": "left/center/right", "color": "..." }
}
Set target_present to true ONLY if you can clearly see the "${targetLabel}". If not visible, set it to false and target_details to null.`

// ── NARRATOR ──────────────────────────────────────────────────────────────────
const NARRATOR_SYSTEM_PROMPT = `Eres un narrador visual accesible para personas ciegas o con discapacidad visual.
Describes lo que ves de forma clara, natural y concisa, como un locutor de radio.
Priorizas: obstáculos inmediatos, peligros, personas cercanas, texto visible, contexto del entorno.
Si el usuario hace una pregunta, respóndela directamente viendo la imagen.
Nunca uses JSON, listas con guiones ni formato especial. Usa frases cortas y naturales.
Responde SIEMPRE en el mismo idioma en que te hablan. Si no hay pregunta, responde en español.`

const NARRATOR_AUTO_PROMPT =
  `Describe el entorno visible en esta imagen para una persona ciega.
Menciona: posición de objetos importantes (izquierda, derecha, cerca, lejos), personas presentes,
posibles obstáculos o peligros, y texto visible si lo hay. Máximo 3 frases cortas y claras.`

// ── Helpers ───────────────────────────────────────────────────────────────────
function captureFrame(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null
): string | null {
  if (!video || !canvas) return null
  const w = video.videoWidth, h = video.videoHeight
  if (!w || !h) return null
  canvas.width = w; canvas.height = h
  canvas.getContext('2d')!.drawImage(video, 0, 0)
  return canvas.toDataURL('image/jpeg', 0.7)
}

async function callNvidia(base64Image: string, promptText: string) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: base64Image } },
        ]},
      ],
      max_tokens: 512, temperature: 0.1, top_p: 0.70,
    }),
  })
  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  try { return JSON.parse(content) } catch { return { raw: content } }
}

async function callNarratorVision(base64Image: string, voiceQuestion?: string): Promise<string> {
  const userText = voiceQuestion
    ? `El usuario preguntó: "${voiceQuestion}". Analiza la imagen y responde directamente.`
    : NARRATOR_AUTO_PROMPT
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: NARRATOR_SYSTEM_PROMPT },
        { role: 'user', content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: base64Image } },
        ]},
      ],
      max_tokens: 200, temperature: 0.3,
    }),
  })
  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() ?? 'No pude analizar la imagen.'
}

// ── Types ─────────────────────────────────────────────────────────────────────
type AlertItem = { type: 'success' | 'danger' | 'warning'; msg: string; time: string }
type DetectedObject = { label: string; color?: string; position?: string; signature?: string; confidence?: number }
type AppTab = 'image' | 'camera' | 'narrator'

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState<AppTab>('image')

  // — detection / tracking state —
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'detection' | 'tracking'>('detection')
  const [targetLabel, setTargetLabel] = useState('')
  const [selectedObject, setSelectedObject] = useState<DetectedObject | null>(null)
  const [count, setCount] = useState(0)
  const [targetStatus, setTargetStatus] = useState<'present' | 'absent' | null>(null)
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const prevPresentRef = useRef<boolean | null>(null)

  // — camera (detection) —
  const videoRef  = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const loopRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cameraActive, setCameraActive] = useState(false)
  const [framesSent, setFramesSent]     = useState(0)
  const [latency, setLatency]           = useState(0)
  const [intervalMs, setIntervalMs]     = useState(500)

  // — narrator state —
  const [narratorCamActive, setNarratorCamActive] = useState(false)
  const [narratorActive, setNarratorActive]       = useState(false)
  const [narratorText, setNarratorText]           = useState('')
  const [narratorIntervalMs, setNarratorIntervalMs] = useState(4000)
  const [narratorLoading, setNarratorLoading]     = useState(false)
  const [micActive, setMicActive]                 = useState(false)
  const [voiceTranscript, setVoiceTranscript]     = useState('')

  // narrator refs (avoid stale closures in async loops)
  const narratorVideoRef   = useRef<HTMLVideoElement>(null)
  const narratorCanvasRef  = useRef<HTMLCanvasElement>(null)
  const narratorLoopRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingQuestionRef = useRef<string | null>(null)
  const recognitionRef     = useRef<InstanceType<typeof SpeechRecognition> | null>(null)
  const isSpeakingRef      = useRef(false)
  const narratorActiveRef  = useRef(false)
  const narratorCamActiveRef  = useRef(false)
  const narratorIntervalRef   = useRef(4000)
  const micActiveRef       = useRef(false)

  useEffect(() => { narratorActiveRef.current    = narratorActive },     [narratorActive])
  useEffect(() => { narratorCamActiveRef.current = narratorCamActive },  [narratorCamActive])
  useEffect(() => { narratorIntervalRef.current  = narratorIntervalMs }, [narratorIntervalMs])

  // ── speak ──────────────────────────────────────────────────────────────────
  function speak(text: string, lang = 'es-ES') {
    if (!window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = lang; utter.rate = 1.1; utter.pitch = 1.0
    isSpeakingRef.current = true
    utter.onend  = () => { isSpeakingRef.current = false }
    utter.onerror = () => { isSpeakingRef.current = false }
    window.speechSynthesis.speak(utter)
  }

  // ── alert ─────────────────────────────────────────────────────────────────
  function addAlert(type: AlertItem['type'], msg: string) {
    const time = new Date().toLocaleTimeString()
    setAlerts(prev => [{ type, msg, time }, ...prev].slice(0, 20))
  }

  // ── tracking result ───────────────────────────────────────────────────────
  function processTrackingResult(result: Record<string, unknown>) {
    if (result?.target_present === undefined) return
    const isPresent = result.target_present as boolean
    const prev = prevPresentRef.current
    if (prev === null) {
      if (isPresent) {
        setCount(1); setTargetStatus('present')
        addAlert('success', `✅ "${targetLabel}" detectado por primera vez`)
        speak(`${targetLabel}. 1`)
      } else {
        setTargetStatus('absent')
        addAlert('warning', `⚠️ "${targetLabel}" no visible al iniciar`)
      }
    } else if (!prev && isPresent) {
      setCount(c => {
        const next = c + 1
        addAlert('success', `✅ "${targetLabel}" reapareció — conteo: ${next}`)
        speak(`${next}`)
        return next
      })
      setTargetStatus('present')
    } else if (prev && !isPresent) {
      setTargetStatus('absent')
      addAlert('danger', `❌ "${targetLabel}" salió de la escena`)
    }
    prevPresentRef.current = isPresent
  }

  // ── image handlers ────────────────────────────────────────────────────────
  function handleImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setImage(file); setPreview(URL.createObjectURL(file)); setResponse(null); setSelectedObject(null)
  }

  function toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload  = () => resolve(reader.result as string)
      reader.onerror = reject
    })
  }

  async function runOnImage(promptText: string) {
    if (!image) { setError('Sube una imagen.'); return }
    setLoading(true); setError(''); setResponse(null)
    try {
      const base64 = await toBase64(image)
      const result = await callNvidia(base64, promptText)
      setResponse(result)
      if (mode === 'tracking') processTrackingResult(result)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally { setLoading(false) }
  }

  // ── detection camera ──────────────────────────────────────────────────────
  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      videoRef.current!.srcObject = stream
      await videoRef.current!.play()
      setCameraActive(true); setFramesSent(0)
    } catch (err: unknown) {
      setError('No se pudo acceder a la cámara: ' + (err instanceof Error ? err.message : ''))
    }
  }

  function stopCamera() {
    if (loopRef.current) clearTimeout(loopRef.current)
    const stream = videoRef.current?.srcObject as MediaStream | null
    stream?.getTracks().forEach(t => t.stop())
    setCameraActive(false)
  }

  // detection refs
  const detectionActiveRef   = useRef(false)
  const detectionModeRef     = useRef<'detection' | 'tracking'>('detection')
  const detectionTargetRef   = useRef('')
  const detectionIntervalRef = useRef(500)
  useEffect(() => { detectionActiveRef.current   = cameraActive }, [cameraActive])
  useEffect(() => { detectionModeRef.current     = mode },         [mode])
  useEffect(() => { detectionTargetRef.current   = targetLabel },  [targetLabel])
  useEffect(() => { detectionIntervalRef.current = intervalMs },   [intervalMs])

  const runDetectionLoop = useRef<() => Promise<void>>()
  runDetectionLoop.current = async () => {
    if (!detectionActiveRef.current) return
    const frame = captureFrame(videoRef.current, canvasRef.current)
    if (frame) {
      const prompt = detectionModeRef.current === 'tracking' && detectionTargetRef.current
        ? TRACKING_PROMPT(detectionTargetRef.current)
        : DETECTION_PROMPT
      const t0 = performance.now()
      try {
        const result = await callNvidia(frame, prompt)
        setLatency(Math.round(performance.now() - t0))
        setFramesSent(p => p + 1)
        setResponse(result)
        if (detectionModeRef.current === 'tracking') processTrackingResult(result)
      } catch (err) { console.error(err) }
    }
    loopRef.current = setTimeout(runDetectionLoop.current!, detectionIntervalRef.current)
  }

  useEffect(() => {
    if (cameraActive) {
      loopRef.current = setTimeout(runDetectionLoop.current!, intervalMs)
    } else {
      if (loopRef.current) clearTimeout(loopRef.current)
    }
    return () => { if (loopRef.current) clearTimeout(loopRef.current) }
  }, [cameraActive]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleDetect() {
    setMode('detection'); setSelectedObject(null); setCount(0); setTargetStatus(null); setAlerts([]); prevPresentRef.current = null
    if (tab === 'image') runOnImage(DETECTION_PROMPT)
  }

  function handleSelectObject(obj: DetectedObject) {
    setSelectedObject(obj); setTargetLabel(obj.label); setMode('tracking')
    setCount(0); setTargetStatus(null); setAlerts([]); prevPresentRef.current = null
  }

  function handleTrack() {
    if (!targetLabel) return
    if (tab === 'image') runOnImage(TRACKING_PROMPT(targetLabel))
  }

  // ── NARRATOR camera ───────────────────────────────────────────────────────
  async function startNarratorCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      narratorVideoRef.current!.srcObject = stream
      await narratorVideoRef.current!.play()
      setNarratorCamActive(true)
      speak('Cámara activada.')
    } catch (err: unknown) {
      speak('Error al acceder a la cámara. Verifica los permisos.')
      setError('No se pudo acceder a la cámara: ' + (err instanceof Error ? err.message : ''))
    }
  }

  function stopNarratorCamera() {
    if (narratorLoopRef.current) clearTimeout(narratorLoopRef.current)
    const stream = narratorVideoRef.current?.srcObject as MediaStream | null
    stream?.getTracks().forEach(t => t.stop())
    setNarratorCamActive(false)
    setNarratorActive(false)
    window.speechSynthesis?.cancel()
  }

  const runNarratorLoop = useRef<() => Promise<void>>()
  runNarratorLoop.current = async () => {
    if (!narratorActiveRef.current || !narratorCamActiveRef.current) return
    if (isSpeakingRef.current) {
      narratorLoopRef.current = setTimeout(runNarratorLoop.current!, 600)
      return
    }
    const frame = captureFrame(narratorVideoRef.current, narratorCanvasRef.current)
    if (frame) {
      setNarratorLoading(true)
      const question = pendingQuestionRef.current
      pendingQuestionRef.current = null
      try {
        const description = await callNarratorVision(frame, question ?? undefined)
        setNarratorText(description)
        speak(description)
      } catch (err) {
        console.error('Narrator vision error:', err)
      } finally {
        setNarratorLoading(false)
      }
    }
    narratorLoopRef.current = setTimeout(runNarratorLoop.current!, narratorIntervalRef.current)
  }

  useEffect(() => {
    if (narratorActive && narratorCamActive) {
      speak('Modo narrador activado. Analizando entorno.')
      narratorLoopRef.current = setTimeout(runNarratorLoop.current!, 1200)
    } else {
      if (narratorLoopRef.current) clearTimeout(narratorLoopRef.current)
      if (!narratorActive) window.speechSynthesis?.cancel()
    }
    return () => { if (narratorLoopRef.current) clearTimeout(narratorLoopRef.current) }
  }, [narratorActive, narratorCamActive]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── MICROPHONE ────────────────────────────────────────────────────────────
  function triggerImmediateNarration(question?: string) {
    if (question) pendingQuestionRef.current = question
    if (narratorLoopRef.current) clearTimeout(narratorLoopRef.current)
    narratorLoopRef.current = setTimeout(runNarratorLoop.current!, 100)
  }

  function startMic() {
    const SpeechRecognitionClass =
      (window as Window & { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition ??
      (window as Window & { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition

    if (!SpeechRecognitionClass) {
      speak('Tu navegador no soporta reconocimiento de voz. Usa Chrome o Edge.')
      return
    }

    const rec = new SpeechRecognitionClass()
    rec.continuous     = true
    rec.interimResults = false
    rec.lang           = 'es-ES'

    rec.onresult = (event: SpeechRecognitionEvent) => {
      const result     = event.results[event.results.length - 1]
      const transcript = result[0].transcript.trim()
      const lower      = transcript.toLowerCase()
      setVoiceTranscript(transcript)

      const PAUSE_CMDS  = ['detener', 'parar', 'stop', 'para', 'silencio', 'quiet']
      const RESUME_CMDS = ['continuar', 'iniciar', 'resume', 'activar', 'sigue', 'continúa']
      const NOW_CMDS    = ['qué ves', 'que ves', 'describe', 'dime', 'what do you see', 'analiza', 'qué hay']

      if (PAUSE_CMDS.some(c => lower.includes(c))) {
        setNarratorActive(false)
        speak('Narración pausada. Di "continuar" para reanudar.')
      } else if (RESUME_CMDS.some(c => lower.includes(c))) {
        setNarratorActive(true)
      } else if (NOW_CMDS.some(c => lower.includes(c))) {
        triggerImmediateNarration()
      } else if (transcript.length > 3) {
        triggerImmediateNarration(transcript)
      }
    }

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === 'not-allowed') {
        speak('Permiso de micrófono denegado.')
        setMicActive(false)
        micActiveRef.current = false
      }
    }

    rec.onend = () => {
      if (micActiveRef.current) {
        try { rec.start() } catch { /* already started */ }
      }
    }

    recognitionRef.current = rec
    micActiveRef.current   = true
    setMicActive(true)
    rec.start()
    speak('Micrófono activado. Puede hablar para hacer preguntas sobre lo que ve la cámara.')
  }

  function stopMic() {
    micActiveRef.current = false
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setMicActive(false)
    setVoiceTranscript('')
  }

  useEffect(() => {
    if (tab !== 'narrator') {
      stopNarratorCamera()
      stopMic()
    }
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const objects = (response?.objects as DetectedObject[] | undefined) ?? []

  return (
    <div className="min-h-screen bg-black text-white p-6">
      <div className="max-w-7xl mx-auto">

        {/* HEADER */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">NVIDIA Vision Tester</h1>
          <p className="text-zinc-400">Multimodal image + camera testing interface</p>
        </div>

        {/* TABS */}
        <div className="flex gap-2 mb-6" role="tablist">
          {([
            { id: 'image',    label: '🖼 Imagen' },
            { id: 'camera',   label: '📷 Cámara' },
            { id: 'narrator', label: '🎙 Narrador' },
          ] as const).map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id}
              onClick={() => { setTab(t.id); setResponse(null); setError('') }}
              className={`px-5 py-2 rounded-2xl font-medium transition-all ${
                tab === t.id ? 'bg-white text-black' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            NARRATOR TAB
        ═══════════════════════════════════════════════════════════════ */}
        {tab === 'narrator' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* LEFT — camera + controls */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6">
              <div className="flex items-center gap-3 mb-2">
                <div aria-hidden className={`w-3 h-3 rounded-full flex-shrink-0 ${narratorActive ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
                <h2 className="text-lg font-semibold">Modo Narrador Visual</h2>
              </div>
              <p className="text-zinc-400 text-sm mb-5">
                Descripción continua del entorno por voz para personas con discapacidad visual.
                La IA analiza la cámara en tiempo real y narra lo que ve.
              </p>

              <div className="relative mb-4 rounded-2xl overflow-hidden bg-zinc-800 aspect-video"
                   role="img" aria-label="Vista de la cámara del narrador">
                <video ref={narratorVideoRef} playsInline muted autoPlay
                  className="w-full h-full object-cover" />
                {!narratorCamActive && (
                  <div className="absolute inset-0 flex items-center justify-center flex-col gap-2 text-zinc-500 text-sm">
                    <span className="text-4xl" aria-hidden>👁</span>
                    <span>Cámara apagada</span>
                  </div>
                )}
                {narratorLoading && (
                  <div className="absolute top-3 right-3 bg-black/75 text-green-400 text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-ping inline-block" />
                    Analizando...
                  </div>
                )}
              </div>
              <canvas ref={narratorCanvasRef} className="hidden" aria-hidden />

              <div className="mb-5">
                <div className="flex justify-between text-xs text-zinc-500 mb-1">
                  <span>⏱ Frecuencia de narración</span>
                  <span className="text-white font-medium">{narratorIntervalMs / 1000}s</span>
                </div>
                <input type="range" min="2000" max="10000" step="1000"
                  value={narratorIntervalMs}
                  onChange={e => setNarratorIntervalMs(Number(e.target.value))}
                  aria-label="Frecuencia de narración en segundos"
                  className="w-full accent-green-400" />
                <div className="flex justify-between text-xs text-zinc-700 mt-0.5">
                  <span>2s (frecuente)</span><span>10s (pausado)</span>
                </div>
              </div>

              <button
                onClick={narratorCamActive ? stopNarratorCamera : startNarratorCamera}
                aria-label={narratorCamActive ? 'Apagar cámara' : 'Encender cámara'}
                className={`w-full py-3 rounded-2xl font-bold mb-3 text-sm transition-all ${
                  narratorCamActive ? 'bg-red-700 hover:bg-red-600' : 'bg-white text-black hover:bg-zinc-100'
                }`}
              >
                {narratorCamActive ? '⏹ Apagar cámara' : '📷 Encender cámara'}
              </button>

              <button
                onClick={() => setNarratorActive(v => !v)}
                disabled={!narratorCamActive}
                aria-pressed={narratorActive}
                className={`w-full py-4 rounded-2xl font-bold mb-3 text-base transition-all disabled:opacity-40 ${
                  narratorActive ? 'bg-green-700 hover:bg-green-600' : 'bg-zinc-700 hover:bg-zinc-600'
                }`}
              >
                {narratorActive ? '🔊 Narrando — toca para pausar' : '▶ Iniciar narración'}
              </button>

              <button
                onClick={micActive ? stopMic : startMic}
                disabled={!narratorCamActive}
                aria-pressed={micActive}
                className={`w-full py-3 rounded-2xl font-bold text-sm transition-all disabled:opacity-40 flex items-center justify-center gap-2 ${
                  micActive ? 'bg-purple-800 hover:bg-purple-700' : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300'
                }`}
              >
                {micActive ? (
                  <>
                    <span className="w-2.5 h-2.5 rounded-full bg-red-400 animate-ping" aria-hidden />
                    Escuchando... (toca para silenciar)
                  </>
                ) : (
                  '🎙 Activar micrófono / preguntas por voz'
                )}
              </button>

              {voiceTranscript && (
                <div role="status" aria-live="polite"
                  className="mt-3 text-xs text-purple-300 italic border border-purple-800/60 bg-purple-900/20 rounded-xl px-3 py-2">
                  🎙 &ldquo;{voiceTranscript}&rdquo;
                </div>
              )}
            </div>

            {/* RIGHT — description */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 flex flex-col">
              <h2 className="text-sm font-semibold text-zinc-400 mb-4">Descripción del entorno</h2>

              {narratorText ? (
                <div className="flex-1 flex flex-col">
                  <div className={`rounded-2xl p-5 border-2 mb-4 transition-all ${
                    narratorActive ? 'border-green-600/70 bg-green-900/10' : 'border-zinc-700 bg-zinc-800/40'
                  }`}>
                    <p role="status" aria-live="polite" className="text-white text-base leading-relaxed">
                      {narratorText}
                    </p>
                  </div>
                  <button onClick={() => speak(narratorText)}
                    aria-label="Repetir última descripción"
                    className="w-full py-2.5 rounded-xl text-sm text-zinc-400 border border-zinc-700 hover:border-zinc-400 hover:text-white transition-all mb-4">
                    🔊 Repetir descripción
                  </button>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 gap-3 py-10">
                  <span className="text-6xl" aria-hidden>👁</span>
                  <p className="text-sm text-center max-w-xs">
                    {narratorCamActive
                      ? 'Inicia la narración para describir el entorno en tiempo real'
                      : 'Enciende la cámara y activa la narración para comenzar'}
                  </p>
                </div>
              )}

              <div className="mt-auto border-t border-zinc-800 pt-4">
                <p className="text-xs text-zinc-500 font-semibold mb-3 uppercase tracking-wide">
                  Comandos de voz disponibles
                </p>
                <div className="flex flex-col gap-2">
                  {[
                    { cmd: '"detener" / "parar"',     desc: 'Pausa la narración',              color: 'text-red-400' },
                    { cmd: '"continuar" / "activar"', desc: 'Reanuda la narración',             color: 'text-green-400' },
                    { cmd: '"describe" / "qué ves"',  desc: 'Descripción inmediata',            color: 'text-blue-400' },
                    { cmd: 'Cualquier pregunta',       desc: 'La IA responde viendo la cámara', color: 'text-purple-400' },
                  ].map(({ cmd, desc, color }) => (
                    <div key={cmd} className="flex items-start gap-2 text-xs">
                      <span className={`font-medium flex-shrink-0 ${color}`}>{cmd}</span>
                      <span className="text-zinc-600">→ {desc}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-zinc-700 mt-3">
                  Reconocimiento de voz funciona mejor en Chrome y Edge. El idioma se detecta automáticamente.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            IMAGE / CAMERA TABS
        ═══════════════════════════════════════════════════════════════ */}
        {tab !== 'narrator' && (
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
                    <input type="range" min="300" max="3000" step="100"
                      value={intervalMs} onChange={e => setIntervalMs(Number(e.target.value))}
                      className="w-full accent-green-400" />
                    <div className="flex justify-between text-xs text-zinc-700 mt-0.5">
                      <span>300ms</span><span>3s</span>
                    </div>
                  </div>
                  <button onClick={cameraActive ? stopCamera : startCamera}
                    className={`w-full py-3 rounded-2xl font-bold mb-4 text-sm ${cameraActive ? 'bg-red-600' : 'bg-white text-black'}`}>
                    {cameraActive ? '⏹ Detener cámara' : '▶ Iniciar cámara'}
                  </button>
                </>
              )}

              <div className={`flex items-center gap-2 mb-4 px-3 py-2 rounded-2xl text-sm font-medium ${
                mode === 'detection' ? 'bg-blue-900/40 text-blue-300' : 'bg-green-900/40 text-green-300'
              }`}>
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
                  {loading && mode === 'tracking' ? 'Analizando...' : '🎯 Analizar frame'}
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
              {mode === 'tracking' && (
                <div className="mb-5">
                  <div className={`rounded-2xl p-5 text-center mb-3 border-2 transition-all ${
                    targetStatus === 'present' ? 'border-green-500 bg-green-900/20' :
                    targetStatus === 'absent'  ? 'border-red-600 bg-red-900/20' :
                    'border-zinc-700 bg-zinc-800/50'
                  }`}>
                    <div className="text-5xl font-bold mb-1">{count}</div>
                    <div className="text-zinc-400 text-sm">apariciones de &ldquo;{targetLabel}&rdquo;</div>
                    <div className={`mt-2 text-sm font-medium ${
                      targetStatus === 'present' ? 'text-green-400' :
                      targetStatus === 'absent'  ? 'text-red-400' : 'text-zinc-500'
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
                      {obj.color      && <span className="text-zinc-400 text-sm ml-2">· {obj.color}</span>}
                      {obj.position   && <span className="text-zinc-500 text-sm ml-2">· {obj.position}</span>}
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
                  {response.scene_summary as string}
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
        )}

      </div>
    </div>
  )
}
