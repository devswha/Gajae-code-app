//! Bounded notification navigation, not installer or browser authority.
//! Pending macOS links survive process replacement. Delivery is at-least-once:
//! a crash after navigation but before its durable ACK can repeat root focus.
use std::sync::Mutex;

use tauri::{webview::PageLoadEvent, Url};

const MAX_LINKS: usize = 16;

pub(crate) fn route(url: &Url) -> Option<String> {
    if url.scheme() != "gajae-app"
        || url.host_str() != Some("open")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > 256
    {
        return None;
    }
    let segments: Vec<_> = url.path_segments()?.collect();
    match segments.as_slice() {
        ["job", id]
            if !id.is_empty()
                && id.len() <= 128
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')) =>
        {
            Some("/".into())
        }
        _ => None,
    }
}

#[derive(Clone)]
pub(crate) struct Delivery {
    epoch: u64,
    sequence: u64,
    pub(crate) urls: Vec<Url>,
}

#[derive(Default)]
struct State {
    urls: Vec<Url>,
    ready: bool,
    epoch: u64,
    sequence: u64,
    in_flight: Option<u64>,
    #[cfg(target_os = "macos")]
    persistence: Option<Persistence>,
}

#[cfg(target_os = "macos")]
struct Persistence {
    root: std::path::PathBuf,
    loaded: bool,
}

impl State {
    fn load(&mut self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if let Some(persistence) = self.persistence.as_mut() {
            if !persistence.loaded {
                let stored = crate::updater_store::LinkStore::open(&persistence.root)?.read()?;
                let mut urls = Vec::new();
                for text in stored {
                    let url = text
                        .parse::<Url>()
                        .map_err(|_| "Invalid stored desktop link.")?;
                    if route(&url).is_none() {
                        return Err("Invalid stored desktop link.".into());
                    }
                    urls.push(url);
                }
                if urls.len() + self.urls.len() > MAX_LINKS {
                    return Err("Pending desktop links are full.".into());
                }
                urls.append(&mut self.urls);
                self.urls = urls;
                persistence.loaded = true;
            }
        }
        Ok(())
    }

    fn save(&self, urls: &[Url]) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if let Some(persistence) = &self.persistence {
            return crate::updater_store::LinkStore::open(&persistence.root)?
                .write(urls.iter().map(|url| url.as_str().to_owned()).collect());
        }
        let _ = urls;
        Ok(())
    }

    fn delivery(&mut self) -> Option<Delivery> {
        if !self.ready || self.urls.is_empty() || self.in_flight.is_some() {
            return None;
        }
        self.sequence = self.sequence.checked_add(1)?;
        self.in_flight = Some(self.sequence);
        Some(Delivery {
            epoch: self.epoch,
            sequence: self.sequence,
            urls: self.urls.clone(),
        })
    }
}

#[derive(Default)]
pub(crate) struct StartupDeepLinks(Mutex<State>);

impl StartupDeepLinks {
    pub(crate) fn new(urls: Vec<Url>) -> Self {
        Self(Mutex::new(State {
            urls: urls
                .into_iter()
                .filter(|url| route(url).is_some())
                .take(MAX_LINKS)
                .collect(),
            ..State::default()
        }))
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn persistent(root: std::path::PathBuf) -> Self {
        let value = Self::new(Vec::new());
        value.0.lock().expect("new desktop links lock").persistence = Some(Persistence {
            root,
            loaded: false,
        });
        value
    }

    pub(crate) fn receive(&self, urls: Vec<Url>) -> Result<Option<Delivery>, String> {
        let mut state = self.0.lock().map_err(|_| "Desktop links lock failed.")?;
        // Keep in-memory arrivals if the data root has not been created yet.
        let loaded = state.load();
        let valid: Vec<_> = urls
            .into_iter()
            .filter(|url| route(url).is_some())
            .take(MAX_LINKS + 1)
            .collect();
        if state.urls.len() + valid.len() > MAX_LINKS {
            return Err("Pending desktop links are full.".into());
        }
        state.urls.extend(valid);
        loaded?;
        state.save(&state.urls)?;
        Ok(state.delivery())
    }

    pub(crate) fn reset(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.ready = false;
            state.epoch = state.epoch.wrapping_add(1);
            state.in_flight = None;
        }
    }

    pub(crate) fn take_for_page(
        &self,
        label: &str,
        url: &Url,
        event: PageLoadEvent,
    ) -> Result<Option<Delivery>, String> {
        if label == "main" && event == PageLoadEvent::Started {
            self.reset();
        }
        if label != "main"
            || event != PageLoadEvent::Finished
            || url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Ok(None);
        }
        let mut state = self.0.lock().map_err(|_| "Desktop links lock failed.")?;
        state.load()?;
        state.save(&state.urls)?;
        state.ready = true;
        Ok(state.delivery())
    }

    pub(crate) fn acknowledge(&self, delivery: Delivery) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "Desktop links lock failed.")?;
        if !state.ready
            || state.epoch != delivery.epoch
            || state.in_flight != Some(delivery.sequence)
            || !state.urls.starts_with(&delivery.urls)
        {
            return Err("Desktop link delivery was retired.".into());
        }
        let remaining = &state.urls[delivery.urls.len()..];
        state.save(remaining)?;
        state.urls.drain(..delivery.urls.len());
        state.in_flight = None;
        Ok(())
    }

    pub(crate) fn release(&self, delivery: &Delivery) {
        if let Ok(mut state) = self.0.lock() {
            if state.epoch == delivery.epoch && state.in_flight == Some(delivery.sequence) {
                state.in_flight = None;
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn flush(&self) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| "Desktop links lock failed.")?;
        state.load()?;
        state.save(&state.urls)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(id: &str) -> Url {
        format!("gajae-app://open/job/{id}").parse().unwrap()
    }
    fn ready(links: &StartupDeepLinks) -> Option<Delivery> {
        links
            .take_for_page(
                "main",
                &"http://127.0.0.1:43123/".parse().unwrap(),
                PageLoadEvent::Finished,
            )
            .unwrap()
    }

    #[test]
    fn exact_navigation_schema_rejects_credentials_suffixes_and_foreign_targets() {
        assert_eq!(route(&link("job_1:2.3-4")), Some("/".into()));
        for raw in [
            "https://example.com/",
            "gajae-app://user@open/job/1",
            "gajae-app://open:123/job/1",
            "gajae-app://open/job/1/extra",
            "gajae-app://open/job/1/",
            "gajae-app://open//job/1",
            "gajae-app://open/job/1?target=x",
            "gajae-app://open/job/1#x",
            "gajae-app://open/job/a%2Fb",
        ] {
            assert!(route(&raw.parse().unwrap()).is_none(), "{raw}");
        }
    }

    #[test]
    fn delivery_is_not_consumption_and_new_arrivals_wait_behind_the_exact_prefix() {
        let links = StartupDeepLinks::new(vec![link("first")]);
        let first = ready(&links).unwrap();
        assert!(links.receive(vec![link("second")]).unwrap().is_none());
        assert!(ready(&links).is_none());
        links.acknowledge(first.clone()).unwrap();
        let next = links.receive(Vec::new()).unwrap().unwrap();
        assert_eq!(next.urls, vec![link("second")]);
        assert!(links.acknowledge(first).is_err());
        links.acknowledge(next).unwrap();
        assert!(ready(&links).is_none());
    }

    #[test]
    fn applying_or_recovery_retires_old_delivery_but_keeps_the_urls() {
        let links = StartupDeepLinks::new(vec![link("saved")]);
        let original = ready(&links).unwrap();
        links.reset();
        assert!(links.acknowledge(original.clone()).is_err());
        assert!(links
            .take_for_page(
                "main",
                &"tauri://localhost/index.html".parse().unwrap(),
                PageLoadEvent::Finished
            )
            .unwrap()
            .is_none());
        let restored = ready(&links).unwrap();
        links.release(&original);
        assert!(links.receive(Vec::new()).unwrap().is_none());
        links.acknowledge(restored).unwrap();
    }

    #[test]
    fn failed_navigation_can_retry_without_consuming_or_reusing_its_delivery() {
        let links = StartupDeepLinks::new(vec![link("saved")]);
        let failed = ready(&links).unwrap();
        links.release(&failed);
        let retry = ready(&links).unwrap();
        assert!(links.acknowledge(failed).is_err());
        assert_eq!(retry.urls, vec![link("saved")]);
        links.acknowledge(retry).unwrap();
    }

    #[test]
    fn startup_and_new_arrivals_are_bounded_without_evicting_accepted_links() {
        let links = StartupDeepLinks::new((0..32).map(|id| link(&id.to_string())).collect());
        assert!(links.receive(vec![link("overflow")]).is_err());
        let delivery = ready(&links).unwrap();
        assert_eq!(delivery.urls.len(), 16);
        assert_eq!(delivery.urls[0], link("0"));
        assert_eq!(delivery.urls[15], link("15"));
    }

    #[cfg(target_os = "macos")]
    mod persistent {
        use super::*;
        use std::{
            fs,
            os::unix::fs::{symlink, PermissionsExt},
        };

        struct Temp(std::path::PathBuf);
        impl Temp {
            fn new() -> Self {
                let mut entropy = [0; 16];
                getrandom::getrandom(&mut entropy).unwrap();
                let path = fs::canonicalize(std::env::temp_dir())
                    .unwrap()
                    .join(format!(
                        "gajae-deep-links-{:032x}",
                        u128::from_ne_bytes(entropy)
                    ));
                fs::create_dir(&path).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                Self(path)
            }
            fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for Temp {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn pending_and_unacknowledged_links_survive_new_owners_until_durable_ack() {
            let temp = Temp::new();
            let root = temp.path().canonicalize().unwrap();
            let first = StartupDeepLinks::persistent(root.clone());
            assert!(first
                .receive(vec![link("before-update")])
                .unwrap()
                .is_none());
            let offered = ready(&first).unwrap();
            assert_eq!(offered.urls, vec![link("before-update")]);
            drop(first);
            let successor = StartupDeepLinks::persistent(root.clone());
            let replayed = ready(&successor).unwrap();
            assert_eq!(replayed.urls, offered.urls);
            successor.acknowledge(replayed).unwrap();
            drop(successor);
            assert!(ready(&StartupDeepLinks::persistent(root)).is_none());
        }

        #[test]
        fn missing_first_boot_root_retains_arrival_for_later_flush() {
            let temp = Temp::new();
            let root = temp.path().canonicalize().unwrap().join("data");
            let links = StartupDeepLinks::persistent(root.clone());
            assert!(links.receive(vec![link("early")]).is_err());
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            links.flush().unwrap();
            assert_eq!(
                ready(&StartupDeepLinks::persistent(root)).unwrap().urls,
                vec![link("early")]
            );
        }

        #[test]
        fn aliased_ack_is_refused_and_never_overwrites_an_external_file() {
            let temp = Temp::new();
            let root = temp.path().canonicalize().unwrap();
            let links = StartupDeepLinks::persistent(root.clone());
            links.receive(vec![link("retained")]).unwrap();
            let offered = ready(&links).unwrap();
            let pending = root.join("desktop-deep-links/pending.json");
            let retained = root.join("desktop-deep-links/retained-test.json");
            let outside = root.join("sentinel");
            fs::write(&outside, b"unchanged").unwrap();
            fs::rename(&pending, &retained).unwrap();
            symlink(&outside, &pending).unwrap();
            assert!(links.acknowledge(offered.clone()).is_err());
            assert_eq!(fs::read(&outside).unwrap(), b"unchanged");
            links.release(&offered);
            fs::remove_file(&pending).unwrap();
            fs::rename(&retained, &pending).unwrap();
            assert_eq!(ready(&links).unwrap().urls, vec![link("retained")]);
        }

        #[test]
        fn corrupt_and_foreign_persisted_urls_are_not_replayed_or_overwritten() {
            let temp = Temp::new();
            let root = temp.path().canonicalize().unwrap();
            let store = crate::updater_store::LinkStore::open(&root).unwrap();
            store.write(vec!["https://example.com/".into()]).unwrap();
            let pending = root.join("desktop-deep-links/pending.json");
            let before = fs::read(&pending).unwrap();
            let links = StartupDeepLinks::persistent(root);
            assert!(links.receive(vec![link("valid-new")]).is_err());
            assert!(links.flush().is_err());
            assert_eq!(fs::read(&pending).unwrap(), before);
        }

        #[test]
        #[ignore = "spawned by pending_links_cross_a_real_process_exit"]
        fn pending_link_writer_child() {
            let root = std::env::var_os("GJC_DEEP_LINK_TEST_ROOT").expect("isolated child root");
            StartupDeepLinks::persistent(root.into())
                .receive(vec![link("process-handoff")])
                .unwrap();
        }

        #[test]
        fn pending_links_cross_a_real_process_exit() {
            let temp = Temp::new();
            let root = temp.path().canonicalize().unwrap();
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "desktop_deep_links::tests::persistent::pending_link_writer_child",
                    "--ignored",
                ])
                .env("GJC_DEEP_LINK_TEST_ROOT", &root)
                .output()
                .unwrap();
            assert!(
                child.status.success(),
                "{}",
                String::from_utf8_lossy(&child.stderr)
            );
            assert_eq!(
                ready(&StartupDeepLinks::persistent(root)).unwrap().urls,
                vec![link("process-handoff")]
            );
        }
    }
}
