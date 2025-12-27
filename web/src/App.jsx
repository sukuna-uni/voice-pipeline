import React, { useState, useRef, useEffect } from 'react'
import './App.css'

const WS_URL = 'ws://localhost:3001/ws/noise-filter'
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
  const [hasRecordings, setHasRecordings] = useState(false)
  const [playing, setPlaying] = useState(false)

  const wsRef = useRef(null)
  const audioContextRef = useRef(null)
  const sourceNodeRef = useRef(null)
  const processorNodeRef = useRef(null)
  const destinationNodeRef = useRef(null)
  const gainNodeRef = useRef(null)
  const streamRef = useRef(null)
  const audioQueueRef = useRef([])
  const isPlayingRef = useRef(false)
  const isRecordingRef = useRef(false)
  const originalAudioChunksRef = useRef([])
  const processedAudioChunksRef = useRef([])

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

  const disconnect = async () => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (recording) {
      await stopRecording()
    }
    
    // Clean up audio context
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      await audioContextRef.current.close()
      audioContextRef.current = null
    }
    
    // Clear recordings
    originalAudioChunksRef.current = []
    processedAudioChunksRef.current = []
    setHasRecordings(false)
    setPlaying(false)
    
    setConnected(false)
    setStatus('Disconnected')
  }

  const startRecording = async () => {
    try {
      setError(null)
      setStatus('Starting microphone...')

      // Check WebSocket connection
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setError('WebSocket not connected. Please connect first.')
        setStatus('Connection required')
        return
      }

      // Clear previous recordings
      originalAudioChunksRef.current = []
      processedAudioChunksRef.current = []
      setHasRecordings(false)

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

      // Create or resume audio context
      let audioContext = audioContextRef.current
      if (!audioContext || audioContext.state === 'closed') {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: sampleRate,
        })
        audioContextRef.current = audioContext
      }
      
      // Resume if suspended
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

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
        if (!isRecordingRef.current) {
          return
        }
        
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          console.warn('WebSocket not ready, skipping audio chunk')
          return
        }

        const inputBuffer = event.inputBuffer
        const inputData = inputBuffer.getChannelData(0)
        
        // Debug: log first chunk to verify callback is firing
        if (originalAudioChunksRef.current.length === 0) {
          console.log('First audio chunk received, length:', inputData.length)
        }

        // Store original audio chunk
        originalAudioChunksRef.current.push(new Float32Array(inputData))

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

        // Send to server for noise filtering
        const buffer = pcm16.buffer
        try {
          wsRef.current.send(buffer)
          // Debug: log first few sends
          if (originalAudioChunksRef.current.length <= 3) {
            console.log('Sent audio chunk to server, size:', buffer.byteLength, 'bytes')
          }
        } catch (err) {
          console.error('Failed to send audio chunk:', err)
        }
      }

      // Connect source to processor
      source.connect(processor)
      // Connect processor to destination - ScriptProcessorNode requires an output connection
      // to fire the onaudioprocess event. We'll use a silent gain node to avoid playback.
      const gainNode = audioContext.createGain()
      gainNode.gain.value = 0 // Silent - we only want to capture, not play
      processor.connect(gainNode)
      gainNode.connect(audioContext.destination)
      gainNodeRef.current = gainNode

      isRecordingRef.current = true
      setRecording(true)
      setStatus('Recording and processing...')
    } catch (err) {
      setError(`Failed to start recording: ${err.message}`)
      setStatus('Recording failed')
      console.error('Recording error:', err)
    }
  }

  const stopRecording = async () => {
    isRecordingRef.current = false

    // Wait a bit for any remaining processed audio chunks to arrive
    await new Promise(resolve => setTimeout(resolve, 500))

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    if (gainNodeRef.current) {
      gainNodeRef.current.disconnect()
      gainNodeRef.current = null
    }

    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect()
      processorNodeRef.current = null
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect()
      sourceNodeRef.current = null
    }

    // Don't close audio context - we need it for playback
    // Just suspend it if needed
    if (audioContextRef.current && audioContextRef.current.state === 'running') {
      await audioContextRef.current.suspend()
    }

    setRecording(false)
    setAudioLevel(0)
    setProcessedAudioLevel(0)

    // Check if we have recordings
    const hasOriginal = originalAudioChunksRef.current.length > 0
    const hasProcessed = processedAudioChunksRef.current.length > 0
    
    if (hasOriginal || hasProcessed) {
      setHasRecordings(true)
      setStatus('Recording stopped - Ready to play back')
    } else {
      setHasRecordings(false)
      setStatus(connected ? 'Connected - Ready to process audio' : 'Disconnected')
    }
  }

  const playAudio = async (audioChunks, label) => {
    if (!audioContextRef.current || audioChunks.length === 0) {
      return
    }

    // Resume audio context if suspended
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    // Calculate total length
    let totalLength = 0
    for (const chunk of audioChunks) {
      totalLength += chunk.length
    }

    // Create audio buffer
    const audioBuffer = audioContextRef.current.createBuffer(1, totalLength, sampleRate)
    const channelData = audioBuffer.getChannelData(0)

    // Concatenate all chunks
    let offset = 0
    for (const chunk of audioChunks) {
      channelData.set(chunk, offset)
      offset += chunk.length
    }

    // Play the audio
    const source = audioContextRef.current.createBufferSource()
    source.buffer = audioBuffer
    source.connect(audioContextRef.current.destination)
    
    return new Promise((resolve) => {
      source.onended = () => resolve()
      source.start()
    })
  }

  const playOriginal = async () => {
    if (playing) return
    
    setPlaying(true)
    setStatus('Playing original audio...')
    try {
      await playAudio(originalAudioChunksRef.current, 'original')
      setStatus('Original audio playback complete')
    } catch (err) {
      setError(`Failed to play original audio: ${err.message}`)
      setStatus('Playback failed')
    } finally {
      setPlaying(false)
    }
  }

  const playProcessed = async () => {
    if (playing) return
    
    setPlaying(true)
    setStatus('Playing processed audio...')
    try {
      await playAudio(processedAudioChunksRef.current, 'processed')
      setStatus('Processed audio playback complete')
    } catch (err) {
      setError(`Failed to play processed audio: ${err.message}`)
      setStatus('Playback failed')
    } finally {
      setPlaying(false)
    }
  }

  const playBoth = async () => {
    if (playing) return
    
    setPlaying(true)
    setStatus('Playing both recordings...')
    try {
      // Play original first
      setStatus('Playing original audio...')
      await playAudio(originalAudioChunksRef.current, 'original')
      
      // Small delay between playbacks
      await new Promise(resolve => setTimeout(resolve, 500))
      
      // Then play processed
      setStatus('Playing processed audio...')
      await playAudio(processedAudioChunksRef.current, 'processed')
      
      setStatus('Both recordings playback complete')
    } catch (err) {
      setError(`Failed to play recordings: ${err.message}`)
      setStatus('Playback failed')
    } finally {
      setPlaying(false)
    }
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

      // Store processed audio chunk
      if (isRecordingRef.current) {
        processedAudioChunksRef.current.push(new Float32Array(float32))
      }

      // Calculate audio level for visualization
      let sum = 0
      for (let i = 0; i < float32.length; i++) {
        sum += Math.abs(float32[i])
      }
      setProcessedAudioLevel((sum / float32.length) * 100)
    } catch (err) {
      console.error('Error handling processed audio:', err)
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
                <button onClick={disconnect} className="btn btn-secondary" disabled={recording || playing}>
                  Disconnect
                </button>
                {!recording ? (
                  <button onClick={startRecording} className="btn btn-success" disabled={playing}>
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

          {hasRecordings && !recording && (
            <div className="playback-controls">
              <h3>Playback</h3>
              <div className="button-group">
                <button 
                  onClick={playOriginal} 
                  className="btn btn-info"
                >
                  Play Original
                </button>
                <button 
                  onClick={playProcessed} 
                  className="btn btn-info"
                >
                  Play Processed
                </button>
                <button 
                  onClick={playBoth} 
                  className="btn btn-primary"
                >
                  Play Both
                </button>
              </div>
            </div>
          )}
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
            <li>Speak into your microphone - watch the audio level meters</li>
            <li>Click "Stop Recording" when done</li>
            <li>After recording, use the playback buttons to hear the original and processed audio</li>
            <li>Compare the difference between original and noise-filtered audio</li>
          </ol>
          <p className="note">
            <strong>Note:</strong> Make sure the server is running with the{' '}
            <code>noise-filter</code> feature enabled. Audio is recorded and processed in real-time,
            then played back after recording stops.
          </p>
        </div>
      </div>
    </div>
  )
}

export default App

