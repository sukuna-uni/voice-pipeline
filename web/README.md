# Noise Filter Test Application

A React application for testing the noise filter WebSocket endpoint in real-time.

## Setup

1. Install dependencies:
```bash
cd web
npm install
```

2. Make sure the Rust server is running with the `noise-filter` feature:
```bash
# From the project root
cargo run --features noise-filter
```

3. Start the development server:
```bash
npm run dev
```

4. Open your browser to `http://localhost:5173`

## Usage

1. Click "Connect" to establish a WebSocket connection to the server
2. Select your desired sample rate (default: 16000 Hz)
3. Click "Start Recording" to begin capturing microphone audio
4. Speak into your microphone - you'll hear both original and processed audio
5. Watch the audio level meters to see the difference between original and filtered audio
6. Click "Stop Recording" when done

## Features

- Real-time audio streaming from microphone
- WebSocket connection to `/ws/noise-filter` endpoint
- Visual audio level meters for original and processed audio
- Configurable sample rates (8000, 16000, 24000, 44100, 48000 Hz)
- Error handling and status indicators

## Technical Details

- **Framework**: React 18 with Vite
- **Audio Processing**: Web Audio API
- **WebSocket**: Native browser WebSocket API
- **Audio Format**: PCM 16-bit, mono
- **Chunk Size**: 4096 samples per chunk

## Development

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build

