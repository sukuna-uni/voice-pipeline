import React, { useState, useRef, useEffect } from 'react'
import './App.css'

const WS_URL = 'ws://localhost:3000/ws/noise-filter'
const DEFAULT_SAMPLE_RATE = 16000
const CHUNK_SIZE = 4096 // Audio chunk size in samples

function App() {
  const [connected, setConnected] = useState(false)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState('Disconnected')
  const [error, setError] = useState(null)
  const [sampleRate, setSampleRate] = useState(DEFAULT_SAMPLE_RATE)
  const [audioLevel, setAudioLevel] = useState(0)
  const [processedAudioLevel, setProcessedAudioLevel] = useState(0)

  const wsRef = useRef(null)
  const audioContextRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const processorNodeRef = useRef(null)
  const destinationNodeRef = useRef(null)
  const streamRef = useRef(null)
  const audioQueueRef = useRef([])
  const isPlayingRef = useRef(false)

  // Initialize audio context and WebSocket on mount
  useEffect(() => {
    return () => {
      // Cleanup on unmount
      disconnect()
    }
  }, [])

  const connect = async () => {
    try {
      setError(null)
      setStatus('Connecting...')

      // Create WebSocket connection
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        setStatus('Connected - Send config to start')
        
        // Send configuration message
        const config = JSON.stringify({ sample_rate: sampleRate })
        ws.send(config)
        setStatus('Configured - Ready to process audio')
      }

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
          // Binary audio data received
          handleProcessedAudio(event.data)
        } else {
          // JSON message (likely error)
          try {
            const message = JSON.parse(event.data)
            if (message.error) {
              setError(message.error)
              setStatus(`Error: ${message.error}`)
            }
          } catch (e) {
            console.warn('Failed to parse message:', e)
          }
        }
      }

      ws.onerror = (err) => {
        console.error('WebSocket error:', err)
        setError('WebSocket connection error')
        setStatus('Connection error')
      }

      ws.onclose = () => {
        setConnected(false)
        setStatus('Disconnected')
        if (recording) {
          stopRecording()
        }
      }
    } catch (err) {
      setError(`Failed to connect: ${err.message}`)
      setStatus('Connection failed')
    }
  }

  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (recording) {
      stopRecording()
    }
    setConnected(false)
    setStatus('Disconnected')
  }

  const startRecording = async () => {
    try {
      setError(null)
      setStatus('Starting microphone...')

      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: sampleRate,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      streamRef.current = stream

      // Create audio context
      const audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: sampleRate,
      })
      audioContextRef.current = audioContext

      // Create source from stream
      const source = audioContext.createMediaStreamSource(stream)
      sourceNodeRef.current = source

      // Create script processor for capturing audio
      const processor = audioContext.createScriptProcessor(CHUNK_SIZE, 1, 1)
      processorNodeRef.current = processor

      // Create destination for playback
      const destination = audioContext.createMediaStreamDestination()
      destinationNodeRef.current = destination

      // Process audio chunks
      processor.onaudioprocess = (event) => {
        if (!recording || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          return
        }

        const inputBuffer = event.inputBuffer
        const inputData = inputBuffer.getChannelData(0)

        // Calculate audio level for visualization
        let sum = 0
        for (let i = 0; i < inputData.length; i++) {
          sum += Math.abs(inputData[i])
        }
        setAudioLevel((sum / inputData.length) * 100)

        // Convert float32 to PCM16
        const pcm16 = new Int16Array(inputData.length)
        for (let i = 0; i < inputData.length; i++) {
          // Clamp to [-1, 1] and convert to 16-bit integer
          const sample = Math.max(-1, Math.min(1, inputData[i]))
          pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF
        }

        // Send to server
        const buffer = pcm16.buffer
        wsRef.current.send(buffer)
      }

      // Connect source to processor
      source.connect(processor)
      processor.connect(audioContext.destination) // Also play original for comparison

      setRecording(true)
      setStatus('Recording and processing...')
    } catch (err) {
      setError(`Failed to start recording: ${err.message}`)
      setStatus('Recording failed')
      console.error('Recording error:', err)
    }
  }

  const stopRecording = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect()
      processorNodeRef.current = null
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect()
      sourceNodeRef.current = null
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    setRecording(false)
    setAudioLevel(0)
    setProcessedAudioLevel(0)
    setStatus(connected ? 'Connected - Ready to process audio' : 'Disconnected')
  }

  const handleProcessedAudio = async (audioData) => {
    try {
      // Convert ArrayBuffer/Blob to ArrayBuffer
      const buffer = audioData instanceof Blob 
        ? await audioData.arrayBuffer() 
        : audioData

      // Convert PCM16 to Float32
      const pcm16 = new Int16Array(buffer)
      const float32 = new Float32Array(pcm16.length)
      
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF)
      }

      // Calculate audio level for visualization
      let sum = 0
      for (let i = 0; i < float32.length; i++) {
        sum += Math.abs(float32[i])
      }
      setProcessedAudioLevel((sum / float32.length) * 100)

      // Play processed audio
      if (audioContextRef.current && audioContextRef.current.state === 'running') {
        const audioBuffer = audioContextRef.current.createBuffer(
          1,
          float32.length,
          sampleRate
        )
        audioBuffer.copyToChannel(float32, 0)

        const source = audioContextRef.current.createBufferSource()
        source.buffer = audioBuffer
        source.connect(audioContextRef.current.destination)
        source.start()
      }
    } catch (err) {
      console.error('Error playing processed audio:', err)
    }
  }

  const handleSampleRateChange = (e) => {
    const newRate = parseInt(e.target.value)
    setSampleRate(newRate)
    if (connected && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Reconfigure with new sample rate
      const config = JSON.stringify({ sample_rate: newRate })
      wsRef.current.send(config)
      setStatus('Reconfigured with new sample rate')
    }
  }

  return (
    <div className="app">
      <div className="container">
        <h1>Noise Filter Test</h1>
        <p className="subtitle">Real-time audio noise reduction using DeepFilterNet</p>

        <div className="controls">
          <div className="control-group">
            <label htmlFor="sample-rate">Sample Rate (Hz):</label>
            <select
              id="sample-rate"
              value={sampleRate}
              onChange={handleSampleRateChange}
              disabled={recording}
            >
              <option value={8000}>8000</option>
              <option value={16000}>16000</option>
              <option value={24000}>24000</option>
              <option value={44100}>44100</option>
              <option value={48000}>48000</option>
            </select>
          </div>

          <div className="button-group">
            {!connected ? (
              <button onClick={connect} className="btn btn-primary">
                Connect
              </button>
            ) : (
              <>
                <button onClick={disconnect} className="btn btn-secondary">
                  Disconnect
                </button>
                {!recording ? (
                  <button onClick={startRecording} className="btn btn-success">
                    Start Recording
                  </button>
                ) : (
                  <button onClick={stopRecording} className="btn btn-danger">
                    Stop Recording
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="status">
          <div className={`status-indicator ${connected ? 'connected' : 'disconnected'}`} />
          <span className="status-text">{status}</span>
        </div>

        {error && (
          <div className="error">
            <strong>Error:</strong> {error}
          </div>
        )}

        {recording && (
          <div className="audio-levels">
            <div className="level-meter">
              <label>Original Audio Level</label>
              <div className="meter-bar">
                <div
                  className="meter-fill original"
                  style={{ width: `${Math.min(audioLevel, 100)}%` }}
                />
              </div>
              <span className="level-value">{audioLevel.toFixed(1)}%</span>
            </div>
            <div className="level-meter">
              <label>Processed Audio Level</label>
              <div className="meter-bar">
                <div
                  className="meter-fill processed"
                  style={{ width: `${Math.min(processedAudioLevel, 100)}%` }}
                />
              </div>
              <span className="level-value">{processedAudioLevel.toFixed(1)}%</span>
            </div>
          </div>
        )}

        <div className="info">
          <h3>How to use:</h3>
          <ol>
            <li>Click "Connect" to establish WebSocket connection</li>
            <li>Select your desired sample rate (default: 16000 Hz)</li>
            <li>Click "Start Recording" to begin capturing microphone audio</li>
            <li>Speak into your microphone - you'll hear both original and processed audio</li>
            <li>Watch the audio level meters to see the difference</li>
            <li>Click "Stop Recording" when done</li>
          </ol>
          <p className="note">
            <strong>Note:</strong> Make sure the server is running with the{' '}
            <code>noise-filter</code> feature enabled.
          </p>
        </div>
      </div>
    </div>
  )
}

export default App

