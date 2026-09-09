//! Bounded native HTTPS transport for updater preparation and isolated probes.
//!
//! The caller owns endpoint and fixture policy. This module only configures a
//! strict HTTPS client and streams successful responses into a hard byte cap.

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{
    header::HeaderMap, redirect::Policy, Certificate, Client, Response, StatusCode, Url,
};

pub const URL_CREDENTIALS_MESSAGE: &str = "request URL credentials are not allowed";

#[derive(Debug)]
pub enum TransportError {
    Request(reqwest::Error),
    Status(StatusCode),
    Stream(reqwest::Error),
    UrlCredentials,
    ContentLengthExceeded { max_bytes: u64 },
    BodyExceeded { max_bytes: u64 },
    SizeOverflow,
    InvalidHeader(&'static str),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Request(error) | Self::Stream(error) => {
                if error.is_timeout() {
                    f.write_str("updater request timed out")
                } else {
                    f.write_str("updater request failed")
                }
            }
            Self::Status(status) => write!(f, "updater HTTP status {}", status.as_u16()),
            Self::UrlCredentials => f.write_str(URL_CREDENTIALS_MESSAGE),
            Self::ContentLengthExceeded { max_bytes } | Self::BodyExceeded { max_bytes } => {
                write!(f, "updater response exceeds {max_bytes} bytes")
            }
            Self::SizeOverflow => f.write_str("updater response size overflow"),
            Self::InvalidHeader(name) => write!(f, "invalid updater {name} header"),
        }
    }
}

pub struct HttpsClient {
    client: Client,
}

pub enum Accept {
    GithubJson,
    Archive,
}

#[derive(Debug)]
pub struct BoundedResponse {
    pub status: StatusCode,
    pub body: Vec<u8>,
    pub location: Option<String>,
    pub retry_after: Option<String>,
}

/// Return bounded metadata without following redirects. The preparation owner
/// must authorize each next URL and interpret status/Retry-After itself.
pub async fn fetch_response(
    client: &HttpsClient,
    url: &Url,
    accept: Accept,
    max_bytes: u64,
) -> Result<BoundedResponse, TransportError> {
    reject_url_credentials(url)?;
    let response = client
        .client
        .get(url.clone())
        .header(
            reqwest::header::USER_AGENT,
            concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION")),
        )
        .header(
            reqwest::header::ACCEPT,
            match accept {
                Accept::GithubJson => "application/vnd.github+json",
                Accept::Archive => "application/octet-stream",
            },
        )
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| TransportError::Request(error.without_url()))?;
    let status = response.status();
    let location = bounded_header(response.headers(), "location", 4096)?;
    let retry_after = bounded_header(response.headers(), "retry-after", 128)?;
    // Error/redirect bodies are not needed to make the policy decision.
    // Dropping them also avoids buffering arbitrary error-page content.
    let body = if status.is_success() {
        read_response_bounded(response, max_bytes).await?
    } else {
        Vec::new()
    };
    Ok(BoundedResponse {
        status,
        body,
        location,
        retry_after,
    })
}

fn bounded_header(
    headers: &HeaderMap,
    name: &'static str,
    max_bytes: usize,
) -> Result<Option<String>, TransportError> {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(TransportError::InvalidHeader(name));
    }
    let value = value
        .to_str()
        .map_err(|_| TransportError::InvalidHeader(name))?;
    if value.is_empty()
        || value.len() > max_bytes
        || value.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
    {
        return Err(TransportError::InvalidHeader(name));
    }
    Ok(Some(value.to_owned()))
}

pub fn build_client(
    extra_root_certificate: Option<Certificate>,
    connect_timeout: Duration,
    total_timeout: Duration,
) -> Result<HttpsClient, reqwest::Error> {
    let mut builder = Client::builder()
        .https_only(true)
        .redirect(Policy::none())
        .connect_timeout(connect_timeout)
        .timeout(total_timeout);
    if let Some(certificate) = extra_root_certificate {
        builder = builder.add_root_certificate(certificate);
    }
    builder.build().map(|client| HttpsClient { client })
}

// Compatibility entrypoints used by the isolated installer probe, not product
// preparation (which consumes bounded status/redirect metadata directly).
#[allow(dead_code)]
pub async fn fetch_manifest(
    client: &HttpsClient,
    endpoint: &Url,
    max_bytes: u64,
) -> Result<Option<Vec<u8>>, TransportError> {
    let response = fetch_response(client, endpoint, Accept::GithubJson, max_bytes).await?;
    if response.status == StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status.is_success() {
        return Err(TransportError::Status(response.status));
    }
    Ok(Some(response.body))
}

#[allow(dead_code)]
pub async fn fetch_bounded(
    client: &HttpsClient,
    url: &Url,
    max_bytes: u64,
) -> Result<Vec<u8>, TransportError> {
    let response = fetch_response(client, url, Accept::Archive, max_bytes).await?;
    if !response.status.is_success() {
        return Err(TransportError::Status(response.status));
    }
    Ok(response.body)
}

fn reject_url_credentials(url: &Url) -> Result<(), TransportError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(TransportError::UrlCredentials);
    }
    Ok(())
}

async fn read_response_bounded(
    response: Response,
    max_bytes: u64,
) -> Result<Vec<u8>, TransportError> {
    reject_advertised_length(response.content_length(), max_bytes)?;

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| TransportError::Stream(error.without_url()))?;
        append_bounded_chunk(&mut body, &chunk, max_bytes)?;
    }
    Ok(body)
}

fn reject_advertised_length(
    content_length: Option<u64>,
    max_bytes: u64,
) -> Result<(), TransportError> {
    if content_length.is_some_and(|length| length > max_bytes) {
        return Err(TransportError::ContentLengthExceeded { max_bytes });
    }
    Ok(())
}

fn append_bounded_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: u64,
) -> Result<(), TransportError> {
    let new_len = body
        .len()
        .checked_add(chunk.len())
        .ok_or(TransportError::SizeOverflow)?;
    if new_len as u64 > max_bytes {
        return Err(TransportError::BodyExceeded { max_bytes });
    }
    body.extend_from_slice(chunk);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PrivateHttpsFixture {
        root: std::path::PathBuf,
        server: Option<std::process::Child>,
        reader: Option<std::thread::JoinHandle<()>>,
    }

    impl PrivateHttpsFixture {
        fn new() -> Self {
            use std::{
                fs,
                os::unix::fs::PermissionsExt,
                process::{Command, Stdio},
            };
            let output = Command::new("mktemp")
                .arg("-d")
                .arg(std::env::temp_dir().join("gajae-private-https.XXXXXX"))
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .expect("mktemp is required for the private HTTPS fixture");
            assert!(
                output.status.success(),
                "could not create private HTTPS fixture"
            );
            let root =
                fs::canonicalize(std::str::from_utf8(&output.stdout).unwrap().trim()).unwrap();
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let fixture = Self {
                root,
                server: None,
                reader: None,
            };
            fs::write(
                fixture.root.join("openssl.cnf"),
                "[req]\ndistinguished_name=dn\n[dn]\n",
            )
            .unwrap();
            fixture.openssl(&[
                "req",
                "-x509",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
                "-nodes",
                "-keyout",
                "ca-key.pem",
                "-out",
                "updater-ca.pem",
                "-days",
                "1",
                "-sha256",
                "-subj",
                "/CN=Disposable Gajae HTTPS CA",
                "-config",
                "openssl.cnf",
                "-addext",
                "basicConstraints=critical,CA:TRUE",
                "-addext",
                "keyUsage=critical,keyCertSign,cRLSign",
            ]);
            fixture.openssl(&[
                "req",
                "-new",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
                "-nodes",
                "-keyout",
                "server-key.pem",
                "-out",
                "server.csr",
                "-sha256",
                "-subj",
                "/CN=Disposable Gajae HTTPS Server",
                "-config",
                "openssl.cnf",
            ]);
            fs::write(
                fixture.root.join("server.ext"),
                concat!(
                    "basicConstraints=critical,CA:FALSE\n",
                    "keyUsage=critical,digitalSignature\n",
                    "extendedKeyUsage=serverAuth\n",
                    "subjectAltName=IP:127.0.0.1\n",
                ),
            )
            .unwrap();
            fixture.openssl(&[
                "x509",
                "-req",
                "-in",
                "server.csr",
                "-CA",
                "updater-ca.pem",
                "-CAkey",
                "ca-key.pem",
                "-set_serial",
                "2",
                "-days",
                "1",
                "-sha256",
                "-out",
                "server.pem",
                "-extfile",
                "server.ext",
            ]);
            for entry in fs::read_dir(&fixture.root).unwrap() {
                fs::set_permissions(entry.unwrap().path(), fs::Permissions::from_mode(0o600))
                    .unwrap();
            }
            fixture
        }

        fn openssl(&self, args: &[&str]) {
            use std::process::{Command, Stdio};
            let status = Command::new("openssl")
                .current_dir(&self.root)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("openssl is required for the private HTTPS fixture");
            assert!(
                status.success(),
                "private HTTPS certificate generation failed"
            );
        }

        fn start(&mut self) -> (Url, std::sync::mpsc::Receiver<String>) {
            use std::{
                io::BufRead,
                process::{Command, Stdio},
                sync::mpsc,
            };
            // TLS wraps each accepted socket before any HTTP read. Only bounded
            // counters/status are emitted; neither key material nor URLs leak.
            let script = r#"
import pathlib, socket, ssl, sys
root = pathlib.Path(sys.argv[1])
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.minimum_version = ssl.TLSVersion.TLSv1_2
context.load_cert_chain(root / 'server.pem', root / 'server-key.pem')
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    listener.listen(2)
    listener.settimeout(10)
    print('READY', listener.getsockname()[1], flush=True)
    rejected, http = 0, 0
    for _ in range(2):
        raw, _ = listener.accept()
        raw.settimeout(3)
        try:
            connection = context.wrap_socket(raw, server_side=True)
        except ssl.SSLError:
            raw.close()
            rejected += 1
            print('TLS_REJECTED', http, flush=True)
            continue
        with connection:
            request = b''
            while b'\r\n\r\n' not in request:
                chunk = connection.recv(1024)
                if not chunk or len(request) + len(chunk) > 8192:
                    raise RuntimeError('missing or oversized fixture request')
                request += chunk
            if not request.startswith(b'GET /fixture HTTP/1.1\r\n'):
                raise RuntimeError('unexpected fixture request')
            http += 1
            body = b'{"fixture":"private-ca"}'
            connection.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
    print('DONE', rejected, http, flush=True)
"#;
            let mut child = Command::new("python3")
                .args(["-I", "-u", "-c", script])
                .arg(&self.root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("python3 is required for the local HTTPS fixture");
            let stdout = child.stdout.take().unwrap();
            self.server = Some(child);
            let (send, receive) = mpsc::channel();
            self.reader = Some(std::thread::spawn(move || {
                for line in std::io::BufReader::new(stdout).lines() {
                    let Ok(line) = line else {
                        break;
                    };
                    if send.send(line).is_err() {
                        break;
                    }
                }
            }));
            let ready = receive
                .recv_timeout(Duration::from_secs(5))
                .expect("private HTTPS server did not start");
            let port: u16 = ready.strip_prefix("READY ").unwrap().parse().unwrap();
            (
                Url::parse(&format!("https://127.0.0.1:{port}/fixture")).unwrap(),
                receive,
            )
        }
    }

    impl Drop for PrivateHttpsFixture {
        fn drop(&mut self) {
            if let Some(child) = self.server.as_mut() {
                if !matches!(child.try_wait(), Ok(Some(_))) {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
            if let Some(reader) = self.reader.take() {
                let _ = reader.join();
            }
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn private_ca_https_succeeds_but_default_client_rejects_before_http() {
        let mut fixture = PrivateHttpsFixture::new();
        let (url, events) = fixture.start();
        let default = build_client(None, Duration::from_secs(2), Duration::from_secs(4)).unwrap();
        let error = tauri::async_runtime::block_on(fetch_bounded(&default, &url, 64)).unwrap_err();
        match error {
            TransportError::Request(error) => {
                assert!(error.is_connect());
                assert!(!error.is_timeout());
                assert!(
                    format!("{error:?}").contains("UnknownIssuer"),
                    "default client must reject the private issuer"
                );
            }
            _ => panic!("default client must fail TLS, not receive an HTTP response"),
        }
        // The server observed a failed TLS handshake and zero HTTP requests.
        assert_eq!(
            events.recv_timeout(Duration::from_secs(5)).unwrap(),
            "TLS_REJECTED 0"
        );
        let pem = std::fs::read(fixture.root.join("updater-ca.pem")).unwrap();
        let custom = build_client(
            Some(Certificate::from_pem(&pem).unwrap()),
            Duration::from_secs(2),
            Duration::from_secs(4),
        )
        .unwrap();
        let body = tauri::async_runtime::block_on(fetch_bounded(&custom, &url, 64)).unwrap();
        assert_eq!(body, br#"{"fixture":"private-ca"}"#);
        assert_eq!(
            events.recv_timeout(Duration::from_secs(5)).unwrap(),
            "DONE 1 1"
        );
        assert!(fixture.server.as_mut().unwrap().wait().unwrap().success());

        // Adding a private root does not relax the existing HTTPS-only policy.
        let mut plain = url;
        plain.set_scheme("http").unwrap();
        assert!(matches!(
            tauri::async_runtime::block_on(fetch_bounded(&custom, &plain, 64)),
            Err(TransportError::Request(error)) if error.is_builder()
        ));
    }

    #[test]
    fn response_headers_reject_ambiguous_oversized_and_control_values() {
        let mut headers = HeaderMap::new();
        assert_eq!(bounded_header(&headers, "location", 4).unwrap(), None);
        headers.insert("location", "abcd".parse().unwrap());
        assert_eq!(
            bounded_header(&headers, "location", 4).unwrap().as_deref(),
            Some("abcd")
        );
        assert!(bounded_header(&headers, "location", 3).is_err());
        headers.append("location", "next".parse().unwrap());
        assert!(matches!(
            bounded_header(&headers, "location", 4096),
            Err(TransportError::InvalidHeader("location"))
        ));
        headers.insert("retry-after", "12\t3".parse().unwrap());
        assert!(bounded_header(&headers, "retry-after", 128).is_err());
        headers.insert("retry-after", "120".parse().unwrap());
        assert_eq!(
            bounded_header(&headers, "retry-after", 128)
                .unwrap()
                .as_deref(),
            Some("120")
        );
    }

    #[test]
    fn metadata_requests_refuse_credentials_and_redact_delivery_tokens() {
        let client = build_client(None, Duration::from_secs(1), Duration::from_secs(1)).unwrap();
        let credentialed = Url::parse("https://secret@192.0.2.1/").unwrap();
        assert!(matches!(
            tauri::async_runtime::block_on(fetch_response(
                &client,
                &credentialed,
                Accept::GithubJson,
                4,
            )),
            Err(TransportError::UrlCredentials)
        ));
        let endpoint =
            Url::parse("https://127.0.0.1:1/archive?token=DELIVERY_TOKEN_SENTINEL").unwrap();
        let error =
            tauri::async_runtime::block_on(fetch_response(&client, &endpoint, Accept::Archive, 4))
                .unwrap_err();
        match error {
            TransportError::Request(error) => {
                assert!(error.url().is_none());
                assert!(!error.to_string().contains("DELIVERY_TOKEN_SENTINEL"));
            }
            other => panic!("expected a redacted request error, got {other:?}"),
        }
    }

    #[test]
    fn strict_client_rejects_plain_http_before_connecting() {
        let client = build_client(None, Duration::from_secs(1), Duration::from_secs(1)).unwrap();
        let endpoint = Url::parse("http://127.0.0.1:1/").unwrap();
        let error =
            tauri::async_runtime::block_on(fetch_bounded(&client, &endpoint, 4)).unwrap_err();
        match error {
            TransportError::Request(error) => assert!(error.is_builder()),
            error => panic!("expected HTTPS policy refusal, got {error:?}"),
        }
    }

    #[test]
    fn manifest_credentials_are_rejected_before_network_access() {
        let client = build_client(None, Duration::from_secs(1), Duration::from_secs(1)).unwrap();
        for credentials in ["qa-user:qa-secret", "qa-user", ":qa-secret", "qa-user:"] {
            let endpoint =
                Url::parse(&format!("https://{credentials}@192.0.2.1/update.json")).unwrap();
            let error =
                tauri::async_runtime::block_on(fetch_manifest(&client, &endpoint, 4)).unwrap_err();
            assert!(matches!(error, TransportError::UrlCredentials));
            assert!(!format!("{error:?}").contains("qa-"));
        }
    }

    #[test]
    fn archive_credentials_are_rejected_before_network_access() {
        let client = build_client(None, Duration::from_secs(1), Duration::from_secs(1)).unwrap();
        for credentials in ["qa-user:qa-secret", "qa-user", ":qa-secret", "qa-user:"] {
            let archive =
                Url::parse(&format!("https://{credentials}@192.0.2.1/B.app.tar.gz")).unwrap();
            let error =
                tauri::async_runtime::block_on(fetch_bounded(&client, &archive, 4)).unwrap_err();
            assert!(matches!(error, TransportError::UrlCredentials));
            assert!(!format!("{error:?}").contains("qa-"));
        }
    }

    #[test]
    fn stream_cap_is_enforced_for_absent_lying_and_oversized_lengths() {
        reject_advertised_length(None, 4).unwrap();
        reject_advertised_length(Some(4), 4).unwrap();
        assert!(matches!(
            reject_advertised_length(Some(5), 4),
            Err(TransportError::ContentLengthExceeded { max_bytes: 4 })
        ));

        let mut body = Vec::new();
        append_bounded_chunk(&mut body, b"12", 4).unwrap();
        // A lying Content-Length of one byte cannot disable the cumulative cap
        // once the stream has supplied more bytes.
        reject_advertised_length(Some(1), 4).unwrap();
        assert!(matches!(
            append_bounded_chunk(&mut body, b"345", 4),
            Err(TransportError::BodyExceeded { max_bytes: 4 })
        ));
        assert_eq!(body, b"12");

        let mut absent_length_body = Vec::new();
        assert!(matches!(
            append_bounded_chunk(&mut absent_length_body, b"12345", 4),
            Err(TransportError::BodyExceeded { max_bytes: 4 })
        ));
        assert!(absent_length_body.is_empty());
    }
}
