//! WebSocket handler for standalone noise filtering
//!
//! This module provides a simple WebSocket endpoint for testing the noise filter
//! functionality. It accepts audio data and returns processed audio with noise reduction.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::Response,
};
use bytes::Bytes;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::utils::noise_filter::reduce_noise_async;

/// Configuration message sent by client to initialize the connection
#[derive(Debug, Deserialize)]
struct NoiseFilterConfig {
    /// Sample rate in Hz (e.g., 16000, 48000)
    sample_rate: u32,
}

/// Error message sent to client
#[derive(Debug, Serialize)]
struct ErrorMessage {
    error: String,
}

/// Connection state for noise filter WebSocket
struct NoiseFilterState {
    sample_rate: Option<u32>,
    configured: bool,
}

impl NoiseFilterState {
    fn new() -> Self {
        Self {
            sample_rate: None,
            configured: false,
        }
    }
}

/// WebSocket noise filter handler
///
/// Upgrades the HTTP connection to WebSocket for real-time noise filtering.
/// Clients should send an initial JSON config message with sample_rate,
/// then stream binary PCM audio data (16-bit, little-endian).
///
/// # Protocol
/// 1. Client connects to `/ws/noise-filter`
/// 2. Client sends JSON config: `{"sample_rate": 16000}`
/// 3. Client streams binary PCM audio data
/// 4. Server returns processed audio as binary messages
/// 5. On error, server sends JSON error message
pub async fn noise_filter_handler(ws: WebSocketUpgrade) -> Response {
    info!("WebSocket noise filter connection upgrade requested");

    let response = ws.on_upgrade(move |socket| {
        debug!("WebSocket upgrade callback triggered for noise filter");
        handle_noise_filter_socket(socket)
    });

    debug!("WebSocket upgrade response created for noise filter");
    response
}

/// Handle WebSocket noise filter connection
///
/// Processes incoming audio data and returns noise-filtered audio.
async fn handle_noise_filter_socket(socket: WebSocket) {
    info!("WebSocket noise filter connection established");

    let (mut sender, mut receiver) = socket.split();
    let state = Arc::new(RwLock::new(NoiseFilterState::new()));

    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                debug!("Received text message: {} bytes", text.len());

                // Try to parse as configuration message
                match serde_json::from_str::<NoiseFilterConfig>(&text) {
                    Ok(config) => {
                        if config.sample_rate == 0 || config.sample_rate > 192000 {
                            let error_msg = serde_json::to_string(&ErrorMessage {
                                error: format!(
                                    "Invalid sample rate: {}. Must be between 1 and 192000 Hz",
                                    config.sample_rate
                                ),
                            })
                            .unwrap_or_else(|_| r#"{"error":"Failed to serialize error"}"#.to_string());

                            if let Err(e) = sender.send(Message::Text(error_msg)).await {
                                error!("Failed to send error message: {}", e);
                                break;
                            }
                            continue;
                        }

                        {
                            let mut state_guard = state.write().await;
                            state_guard.sample_rate = Some(config.sample_rate);
                            state_guard.configured = true;
                        }

                        info!("Noise filter configured with sample rate: {} Hz", config.sample_rate);
                        debug!("Configuration successful, ready to process audio");
                    }
                    Err(e) => {
                        warn!("Failed to parse config message: {}", e);
                        let error_msg = serde_json::to_string(&ErrorMessage {
                            error: format!("Invalid config message: {}. Expected: {{\"sample_rate\": 16000}}", e),
                        })
                        .unwrap_or_else(|_| r#"{"error":"Failed to serialize error"}"#.to_string());

                        if let Err(e) = sender.send(Message::Text(error_msg)).await {
                            error!("Failed to send error message: {}", e);
                            break;
                        }
                    }
                }
            }
            Ok(Message::Binary(data)) => {
                debug!("Received binary audio data: {} bytes", data.len());

                // Check if configured
                let sample_rate = {
                    let state_guard = state.read().await;
                    if !state_guard.configured {
                        let error_msg = serde_json::to_string(&ErrorMessage {
                            error: "Not configured. Send config message with sample_rate first.".to_string(),
                        })
                        .unwrap_or_else(|_| r#"{"error":"Failed to serialize error"}"#.to_string());

                        if let Err(e) = sender.send(Message::Text(error_msg)).await {
                            error!("Failed to send error message: {}", e);
                            break;
                        }
                        continue;
                    }
                    state_guard.sample_rate.unwrap()
                };

                // Process audio through noise filter
                let pcm = Bytes::from(data);
                match reduce_noise_async(pcm, sample_rate).await {
                    Ok(processed_audio) => {
                        debug!(
                            "Processed audio: {} bytes -> {} bytes",
                            data.len(),
                            processed_audio.len()
                        );

                        // Send processed audio back as binary
                        if let Err(e) = sender.send(Message::Binary(processed_audio.into())).await {
                            error!("Failed to send processed audio: {}", e);
                            break;
                        }
                    }
                    Err(e) => {
                        error!("Failed to process audio: {}", e);
                        let error_msg = serde_json::to_string(&ErrorMessage {
                            error: format!("Audio processing failed: {}", e),
                        })
                        .unwrap_or_else(|_| r#"{"error":"Failed to serialize error"}"#.to_string());

                        if let Err(e) = sender.send(Message::Text(error_msg)).await {
                            error!("Failed to send error message: {}", e);
                            break;
                        }
                    }
                }
            }
            Ok(Message::Ping(_)) => {
                debug!("Received ping message");
                // Ping/Pong is handled automatically by axum
            }
            Ok(Message::Pong(_)) => {
                debug!("Received pong message");
            }
            Ok(Message::Close(_)) => {
                info!("WebSocket noise filter connection closed by client");
                break;
            }
            Err(e) => {
                error!("WebSocket error: {}", e);
                break;
            }
        }
    }

    info!("WebSocket noise filter connection ended");
}

