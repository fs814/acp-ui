use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::agent::{AgentMessage, AgentStderr};

pub struct WsConnection {
    tx: mpsc::UnboundedSender<String>,
    task_handle: tokio::task::JoinHandle<()>,
}

impl WsConnection {
    pub async fn connect(
        url: &str,
        agent_id: String,
        app_handle: AppHandle,
    ) -> Result<Self, String> {
        let (ws_stream, _) = connect_async(url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        let (mut ws_sink, mut ws_stream_read) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();

        let agent_id_clone = agent_id.clone();
        let app_handle_clone = app_handle.clone();

        let task_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    // Read from WebSocket stream and emit to frontend
                    msg = ws_stream_read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                let agent_message = AgentMessage {
                                    agent_id: agent_id_clone.clone(),
                                    message: text.to_string(),
                                };
                                let _ = app_handle_clone.emit("agent-message", agent_message);
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                let _ = app_handle_clone.emit("agent-closed", &agent_id_clone);
                                break;
                            }
                            Some(Err(e)) => {
                                let stderr_msg = AgentStderr {
                                    agent_id: agent_id_clone.clone(),
                                    line: format!("WebSocket error: {}", e),
                                };
                                let _ = app_handle_clone.emit("agent-stderr", stderr_msg);
                                let _ = app_handle_clone.emit("agent-closed", &agent_id_clone);
                                break;
                            }
                            _ => {
                                // Ignore binary, ping, pong frames
                            }
                        }
                    }
                    // Read from mpsc channel and send to WebSocket
                    msg = rx.recv() => {
                        match msg {
                            Some(text) => {
                                if ws_sink.send(Message::Text(text.into())).await.is_err() {
                                    let _ = app_handle_clone.emit("agent-closed", &agent_id_clone);
                                    break;
                                }
                            }
                            None => {
                                // Channel closed, shut down gracefully
                                let _ = ws_sink.send(Message::Close(None)).await;
                                break;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self { tx, task_handle })
    }

    pub fn send(&self, message: &str) -> Result<(), String> {
        self.tx
            .send(message.to_string())
            .map_err(|e| format!("Failed to send WebSocket message: {}", e))
    }

    pub fn close(self) {
        // Dropping tx causes rx.recv() to return None, which sends a WS close frame.
        // Give the task a moment to send the close frame before aborting.
        drop(self.tx);
        let handle = self.task_handle;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            handle.abort();
        });
    }
}
