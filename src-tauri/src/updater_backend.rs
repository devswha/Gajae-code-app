//! Authenticated backend control transport. No installer or process signals.
use std::{
    io::{Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Instant,
};

use serde::{Deserialize, Serialize};

const MAX_FRAME: usize = 4096;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Control {
    Status,
    Prepare {
        attempt_id: String,
        draft_epoch: u64,
        remaining_ms: u64,
    },
    Commit {
        attempt_id: String,
        token: String,
    },
    Cancel {
        attempt_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    Open,
    Preparing,
    Prepared,
    Committed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Outcome {
    pub ok: bool,
    pub state: State,
    pub attempt_id: Option<String>,
    pub token: Option<String>,
    pub expires_in_ms: Option<u64>,
    pub error: Option<String>,
}

impl Outcome {
    fn valid(&self) -> bool {
        self.attempt_id.as_deref().is_none_or(hex_id)
            && self.token.as_deref().is_none_or(|value| {
                !value.is_empty()
                    && value.len() <= 256
                    && value.as_bytes()[0].is_ascii_alphanumeric()
                    && value
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
            })
            && self
                .expires_in_ms
                .is_none_or(|value| value > 0 && value <= 10_000)
            && self.error.as_deref().is_none_or(|value| {
                !value.is_empty()
                    && value.len() <= 64
                    && value.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
            })
            && self.ok == self.error.is_none()
    }
}

pub(crate) fn hex_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

struct Connection {
    stream: UnixStream,
    sequence: u64,
}
pub(crate) struct Backend {
    epoch: String,
    connection: Mutex<Connection>,
    shutdown: UnixStream,
    retired: AtomicBool,
}

impl Backend {
    /// The bridge calls this only AFTER endpoint proof, kernel peer-PID and
    /// exact initialization-secret/epoch authentication.
    pub(crate) fn new(stream: UnixStream, epoch: String) -> Result<Self, &'static str> {
        if !hex_id(&epoch) {
            return Err("updater_backend_invalid");
        }
        stream
            .set_nonblocking(false)
            .map_err(|_| "updater_backend_unavailable")?;
        let shutdown = stream
            .try_clone()
            .map_err(|_| "updater_backend_unavailable")?;
        Ok(Self {
            epoch,
            connection: Mutex::new(Connection {
                stream,
                sequence: 0,
            }),
            shutdown,
            retired: AtomicBool::new(false),
        })
    }
    pub(crate) fn available(&self) -> bool {
        !self.retired.load(Ordering::Acquire)
    }
    pub(crate) fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        // No mutex: retiring a run on the GUI thread must unblock a concurrent
        // control read rather than waiting behind its deadline.
        let _ = self.shutdown.shutdown(Shutdown::Both);
    }
    pub(crate) fn request(
        &self,
        command: Control,
        deadline: Instant,
    ) -> Result<Outcome, &'static str> {
        let result = self.request_inner(command, deadline);
        if result.is_err() {
            self.retire();
        }
        result
    }
    fn request_inner(&self, command: Control, deadline: Instant) -> Result<Outcome, &'static str> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| "updater_backend_unavailable")?;
        if !self.available() || Instant::now() >= deadline || connection.sequence >= MAX_SEQUENCE {
            return Err("updater_backend_unavailable");
        }
        connection.sequence += 1;
        let id = connection.sequence;
        let frame = serde_json::json!({ "protocolVersion": 1, "kind": "restartControl", "epoch": self.epoch, "id": id, "command": command });
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| "updater_backend_invalid")?;
        bytes.push(b'\n');
        if bytes.len() > MAX_FRAME {
            return Err("updater_backend_invalid");
        }
        connection
            .stream
            .set_write_timeout(Some(deadline.saturating_duration_since(Instant::now())))
            .map_err(|_| "updater_backend_unavailable")?;
        connection
            .stream
            .write_all(&bytes)
            .map_err(|_| "updater_backend_unavailable")?;
        let frame = read_frame(&mut connection.stream, deadline)?;
        let object = frame.as_object().ok_or("updater_backend_invalid")?;
        if object.len() != 5
            || frame["protocolVersion"] != 1
            || frame["kind"] != "restartControlResult"
            || frame["epoch"] != self.epoch
            || frame["id"].as_u64() != Some(id)
        {
            return Err("updater_backend_invalid");
        }
        let result = frame["result"]
            .as_object()
            .ok_or("updater_backend_invalid")?;
        if result.len() != 6
            || ["ok", "state", "attemptId", "token", "expiresInMs", "error"]
                .iter()
                .any(|key| !result.contains_key(*key))
        {
            return Err("updater_backend_invalid");
        }
        let outcome: Outcome = serde_json::from_value(frame["result"].clone())
            .map_err(|_| "updater_backend_invalid")?;
        if !outcome.valid() || !self.available() || Instant::now() >= deadline {
            return Err("updater_backend_invalid");
        }
        Ok(outcome)
    }
}

fn read_frame(
    stream: &mut UnixStream,
    deadline: Instant,
) -> Result<serde_json::Value, &'static str> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("updater_backend_timeout");
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "updater_backend_unavailable")?;
        let count = stream
            .read(&mut chunk)
            .map_err(|_| "updater_backend_unavailable")?;
        if count == 0 || bytes.len() + count > MAX_FRAME {
            return Err("updater_backend_invalid");
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(newline) = bytes.iter().position(|byte| *byte == b'\n') {
            if newline != bytes.len() - 1 {
                return Err("updater_backend_invalid");
            }
            return serde_json::from_slice(&bytes[..newline])
                .map_err(|_| "updater_backend_invalid");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn exact_correlated_exchange_and_retirement() {
        let (native, mut node) = UnixStream::pair().unwrap();
        let backend = Backend::new(native, "a".repeat(64)).unwrap();
        let peer = std::thread::spawn(move || {
            let request = read_frame(&mut node, Instant::now() + Duration::from_secs(1)).unwrap();
            assert_eq!(request["command"], serde_json::json!({"action":"status"}));
            let reply = serde_json::json!({"protocolVersion":1,"kind":"restartControlResult","epoch":request["epoch"],"id":request["id"],
                "result":{"ok":true,"state":"open","attemptId":null,"token":null,"expiresInMs":null,"error":null}});
            writeln!(node, "{reply}").unwrap();
        });
        assert_eq!(
            backend
                .request(Control::Status, Instant::now() + Duration::from_secs(1))
                .unwrap()
                .state,
            State::Open
        );
        backend.retire();
        assert!(backend
            .request(Control::Status, Instant::now() + Duration::from_secs(1))
            .is_err());
        peer.join().unwrap();
    }

    #[test]
    fn forged_or_incomplete_results_retire_the_channel() {
        for malformed in [
            serde_json::json!({}),
            serde_json::json!({"ok":true,"state":"open","attemptId":null,"token":null,"expiresInMs":null}),
        ] {
            let (native, mut node) = UnixStream::pair().unwrap();
            let backend = Backend::new(native, "b".repeat(64)).unwrap();
            let peer = std::thread::spawn(move || {
                let request =
                    read_frame(&mut node, Instant::now() + Duration::from_secs(1)).unwrap();
                writeln!(node, "{}", serde_json::json!({"protocolVersion":1,"kind":"restartControlResult","epoch":request["epoch"],"id":request["id"],"result":malformed})).unwrap();
            });
            assert!(backend
                .request(Control::Status, Instant::now() + Duration::from_secs(1))
                .is_err());
            assert!(!backend.available());
            peer.join().unwrap();
        }
    }
}
