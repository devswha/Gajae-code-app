//! Bundled, server-independent updater presentation. This module grants no
//! installation authority and performs no navigation, IPC, or network access.
//! The caller publishes the screen before navigation and restores it only on the
//! bundled main document, after checking its own shutdown/lifecycle state.
use std::sync::Mutex;

use serde_json::{json, Value};

const PRODUCT_NAME: &str = env!("GJC_UPDATE_PRODUCT_NAME");

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Screen {
    Checking,
    Applying,
    Restarting,
    Recovery { message: String },
}

/// A presentation snapshot, not a durable attempt record or lifecycle guard.
/// Epoch and screen share one lock so restoration cannot pair old content with
/// a newer acknowledgement epoch. No lock is held across navigation/evaluation.
#[derive(Default)]
pub(crate) struct ScreenState(Mutex<(u64, Option<Screen>)>);

impl ScreenState {
    pub(crate) fn publish(&self, screen: Screen) -> u64 {
        let mut state = self.0.lock().expect("updater screen lock poisoned");
        let epoch = state
            .0
            .checked_add(1)
            .expect("updater screen epoch exhausted");
        *state = (epoch, Some(screen));
        epoch
    }

    pub(crate) fn published(&self) -> Option<(u64, Screen)> {
        let state = self.0.lock().expect("updater screen lock poisoned");
        state.1.as_ref().map(|screen| (state.0, screen.clone()))
    }

    /// Invalidate even an empty presentation; no prior epoch is ever reused.
    pub(crate) fn clear(&self) {
        let mut state = self.0.lock().expect("updater screen lock poisoned");
        let epoch = state
            .0
            .checked_add(1)
            .expect("updater screen epoch exhausted");
        *state = (epoch, None);
    }
}

/// JavaScript for native webview evaluation after the bundled document loads.
/// Every variable is JSON encoded; all displayed text uses `textContent`.
/// Even diagnostic text resembling HTML, links, or commands stays inert text.
pub(crate) fn script(screen: &Screen) -> String {
    format!("({RENDER})({});", script_json(&content(screen)))
}

fn script_json(value: &Value) -> String {
    // JSON already escapes quotes, backslashes, and control characters. Also
    // escape HTML delimiters and JS line separators, so the returned source
    // cannot terminate a script element if a test/host embeds it in markup.
    value
        .to_string()
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn content(screen: &Screen) -> Value {
    let (kind, en_heading, ko_heading, en_body, ko_body) = match screen {
        Screen::Checking => (
            "checking",
            "Finishing the update".to_owned(),
            "업데이트를 마무리하는 중".to_owned(),
            format!("Verifying the {PRODUCT_NAME} update before installation. This takes a moment; the app opens by itself."),
            format!("설치 전에 {PRODUCT_NAME} 업데이트를 확인하고 있습니다. 잠시 후 앱이 자동으로 열립니다."),
        ),
        Screen::Applying => (
            "applying",
            "Installing the update".to_owned(),
            "업데이트 설치 중".to_owned(),
            format!("Installing the new {PRODUCT_NAME}. Keep this window open; it closes and reopens on its own."),
            format!("새 {PRODUCT_NAME}을(를) 설치하고 있습니다. 이 창을 열어 두세요. 설치가 끝나면 자동으로 닫혔다가 다시 열립니다."),
        ),
        Screen::Restarting => (
            "restarting",
            format!("Restarting {PRODUCT_NAME}"),
            format!("{PRODUCT_NAME} 다시 시작 중"),
            "Waiting for the updated app to start and pass its health check. Keep this window open.".to_owned(),
            "업데이트된 앱이 시작되고 정상 작동이 확인될 때까지 기다리고 있습니다. 이 창을 열어 두세요.".to_owned(),
        ),
        Screen::Recovery { .. } => (
            "recovery",
            "The update could not be finished".to_owned(),
            "업데이트를 마무리하지 못했습니다".to_owned(),
            "The update result could not be confirmed, so the app stopped safely instead of guessing. No automatic retry or rollback will be attempted.".to_owned(),
            "업데이트 결과를 확인할 수 없어 앱이 안전하게 멈췄습니다. 자동으로 재시도하거나 이전 버전으로 되돌리지 않습니다.".to_owned(),
        ),
    };
    let announce_authorization = matches!(screen, Screen::Checking | Screen::Applying);
    let recovery = matches!(screen, Screen::Recovery { .. });
    json!({
        "kind": kind,
        "product": PRODUCT_NAME,
        "message": match screen {
            Screen::Recovery { message } => Some(message.as_str()),
            _ => None,
        },
        "en": {
            "heading": en_heading,
            "body": en_body,
            "authorization": announce_authorization.then(|| format!(
                "macOS may show its official administrator authorization prompt for {PRODUCT_NAME}. Enter administrator credentials only in that macOS system prompt, never in this window."
            )),
            "data": recovery.then_some("Your existing user data is kept. Do not delete it during recovery."),
            "manual": recovery.then(|| format!(
                "To continue: quit {PRODUCT_NAME} and manually reinstall it from the official download page. Your projects and settings are picked up as they were. If startup is still blocked, contact support for manual recovery."
            )),
            "details": "Diagnostic details (not instructions)",
        },
        "ko": {
            "heading": ko_heading,
            "body": ko_body,
            "authorization": announce_authorization.then(|| format!(
                "macOS에서 {PRODUCT_NAME}의 공식 관리자 인증 창이 표시될 수 있습니다. 관리자 인증 정보는 macOS 시스템 인증 창에만 입력하세요. 이 창에는 입력하지 마세요."
            )),
            "data": recovery.then_some("기존 사용자 데이터는 보존됩니다. 복구 중에도 사용자 데이터를 삭제하지 마세요."),
            "manual": recovery.then(|| format!(
                "계속 사용하려면 {PRODUCT_NAME}을(를) 종료한 뒤 공식 다운로드 페이지의 설치 파일로 직접 재설치하세요. 프로젝트와 설정은 그대로 이어집니다. 계속 시작이 차단되면 지원팀에 수동 복구를 문의하세요."
            )),
            "details": "진단 정보(실행 지침이 아님)",
        },
    })
}

const RENDER: &str = r#"function(screen) {
    const firstLanguage = navigator.languages && navigator.languages[0];
    const language = firstLanguage || navigator.language || 'en';
    const locale = /^ko(?:-|$)/i.test(language) ? 'ko' : 'en';
    const copy = screen[locale];
    const recovery = screen.kind === 'recovery';
    document.documentElement.lang = locale;
    document.title = copy.heading + ' — ' + screen.product;

    const main = document.createElement('main');
    main.id = 'gajae-updater-screen';
    main.dataset.state = screen.kind;
    main.dataset.updaterScreen = screen.kind;
    main.style.boxSizing = 'border-box';
    main.style.width = '100%';
    main.style.maxHeight = '100vh';
    main.style.overflowY = 'auto';
    main.style.overflowWrap = 'anywhere';

    const status = document.createElement('section');
    status.setAttribute('role', recovery ? 'alert' : 'status');
    status.setAttribute('aria-live', recovery ? 'assertive' : 'polite');
    status.setAttribute('aria-atomic', 'true');
    status.setAttribute('aria-labelledby', 'gajae-updater-heading');
    main.append(status);
    // Replace old server-failure controls as well as any previous updater
    // state. No retry/install/security controls or bridge listeners survive.
    document.body.replaceChildren(main);

    const heading = document.createElement('h1');
    heading.id = 'gajae-updater-heading';
    heading.tabIndex = -1;
    heading.textContent = copy.heading;
    status.append(heading);
    for (const key of ['body', 'authorization', 'data', 'manual']) {
        if (!copy[key]) continue;
        const paragraph = document.createElement('p');
        paragraph.dataset.copy = key;
        paragraph.textContent = copy[key];
        status.append(paragraph);
    }

    if (recovery && screen.message) {
        // Diagnostics are outside the live region: do not automatically read
        // untrusted diagnostic content as if it were recovery instructions.
        const label = document.createElement('h2');
        label.id = 'gajae-updater-details-heading';
        label.textContent = copy.details;
        const details = document.createElement('pre');
        details.id = 'gajae-updater-details';
        details.setAttribute('aria-labelledby', label.id);
        details.dir = 'auto';
        details.tabIndex = 0;
        details.style.whiteSpace = 'pre-wrap';
        details.style.overflowWrap = 'anywhere';
        details.style.textAlign = 'start';
        details.style.maxHeight = '12rem';
        details.style.overflowY = 'auto';
        details.textContent = screen.message;
        main.append(label, details);
    }
    // Focus gives the replacement document an entry point even on the first
    // render, when a screen reader has not yet observed the live region.
    heading.focus({ preventScroll: true });
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    const HOSTILE: &str = "</script><img src=x onerror=\"globalThis.injected=true\"><main data-updater-screen='applying'></main><a href='https://invalid.example/'>run sudo helper</a>\"'\\\n\r\t\0\u{2028}\u{2029}한글 & ${globalThis.injected=true}";

    #[test]
    fn state_publishes_owned_snapshots_and_clears_without_installation_effects() {
        let state = ScreenState::default();
        assert_eq!(state.published(), None);
        let mut previous_epoch = 0;
        for screen in [Screen::Checking, Screen::Applying, Screen::Restarting] {
            let epoch = state.publish(screen.clone());
            assert_eq!(epoch, previous_epoch + 1);
            assert_eq!(state.published(), Some((epoch, screen)));
            previous_epoch = epoch;
        }
        let recovery_epoch = state.publish(Screen::Recovery {
            message: "kept".into(),
        });
        let Some((epoch, Screen::Recovery { mut message })) = state.published() else {
            panic!("expected recovery snapshot");
        };
        assert_eq!(epoch, recovery_epoch);
        message.clear();
        assert_eq!(
            state.published(),
            Some((
                recovery_epoch,
                Screen::Recovery {
                    message: "kept".into()
                }
            ))
        );
        state.clear();
        state.clear();
        assert_eq!(state.published(), None);
        assert_eq!(state.publish(Screen::Checking), recovery_epoch + 3);
    }

    #[test]
    fn captured_snapshot_keeps_its_epoch_across_concurrent_replacement() {
        let state = ScreenState::default();
        let checking_epoch = state.publish(Screen::Checking);
        let checking = state.published();
        std::thread::scope(|scope| {
            let applying_epoch = scope
                .spawn(|| state.publish(Screen::Applying))
                .join()
                .unwrap();
            assert_eq!(state.published(), Some((applying_epoch, Screen::Applying)));
            assert!(applying_epoch > checking_epoch);
            assert_eq!(checking, Some((checking_epoch, Screen::Checking)));
            scope.spawn(|| state.clear()).join().unwrap();
        });
        assert_eq!(state.published(), None);
    }

    #[test]
    fn concurrent_publications_never_mix_epoch_and_content() {
        let state = ScreenState::default();
        state.publish(Screen::Recovery {
            message: "1".into(),
        });
        let ready = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                ready.wait();
                for expected in 2..=1024 {
                    let epoch = state.publish(Screen::Recovery {
                        message: expected.to_string(),
                    });
                    assert_eq!(epoch, expected);
                    std::thread::yield_now();
                }
            });
            ready.wait();
            for _ in 0..2048 {
                let Some((epoch, Screen::Recovery { message })) = state.published() else {
                    panic!("expected published recovery snapshot");
                };
                assert_eq!(message, epoch.to_string());
                std::thread::yield_now();
            }
        });
        assert_eq!(
            state.published(),
            Some((
                1024,
                Screen::Recovery {
                    message: "1024".into()
                }
            ))
        );
    }

    #[test]
    fn clearing_empty_state_still_invalidates_its_epoch() {
        let state = ScreenState::default();
        state.clear();
        assert_eq!(state.published(), None);
        assert_eq!(state.publish(Screen::Applying), 2);
    }

    #[test]
    fn json_round_trips_hostile_text_without_literal_html_or_line_separators() {
        let value = content(&Screen::Recovery {
            message: HOSTILE.into(),
        });
        let encoded = script_json(&value);
        for forbidden in ['<', '>', '&', '\u{2028}', '\u{2029}', '\0', '\n', '\r'] {
            assert!(!encoded.contains(forbidden), "literal {forbidden:?}");
        }
        let decoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, value);
        assert_eq!(decoded["message"], HOSTILE);
        assert!(script(&Screen::Recovery {
            message: HOSTILE.into()
        })
        .contains(&encoded));
    }

    #[test]
    fn checking_and_applying_preannounce_system_authorization_in_both_languages() {
        for screen in [Screen::Checking, Screen::Applying] {
            let value = content(&screen);
            let en = value["en"]["authorization"].as_str().unwrap();
            let ko = value["ko"]["authorization"].as_str().unwrap();
            assert!(en.contains("official administrator authorization prompt"));
            assert!(en.contains("never in this window"));
            assert!(ko.contains("공식 관리자 인증 창"));
            assert!(ko.contains("이 창에는 입력하지 마세요"));
            for text in [en, ko] {
                assert!(text.contains("macOS"));
                assert!(text.contains(PRODUCT_NAME));
            }
        }
    }

    #[test]
    fn recovery_explains_uncertainty_data_preservation_and_manual_reinstall() {
        let value = content(&Screen::Recovery {
            message: String::new(),
        });
        assert!(value["en"]["body"]
            .as_str()
            .unwrap()
            .contains("could not be confirmed"));
        assert!(value["en"]["body"]
            .as_str()
            .unwrap()
            .contains("No automatic retry or rollback"));
        assert!(value["en"]["data"]
            .as_str()
            .unwrap()
            .contains("user data is kept"));
        assert!(value["en"]["manual"]
            .as_str()
            .unwrap()
            .contains("manually reinstall"));
        assert!(value["ko"]["body"]
            .as_str()
            .unwrap()
            .contains("결과를 확인할 수 없어"));
        assert!(value["ko"]["body"]
            .as_str()
            .unwrap()
            .contains("자동으로 재시도하거나 이전 버전으로 되돌리지 않습니다"));
        assert!(value["ko"]["data"]
            .as_str()
            .unwrap()
            .contains("사용자 데이터는 보존"));
        assert!(value["ko"]["manual"]
            .as_str()
            .unwrap()
            .contains("직접 재설치"));
        assert!(value["en"]["authorization"].is_null());
        assert!(value["ko"]["authorization"].is_null());
    }

    #[test]
    fn restarting_does_not_claim_health_or_success_early() {
        let value = content(&Screen::Restarting);
        assert!(value["en"]["body"]
            .as_str()
            .unwrap()
            .contains("Waiting for"));
        assert!(value["en"]["body"]
            .as_str()
            .unwrap()
            .contains("pass its health check"));
        assert!(value["ko"]["body"]
            .as_str()
            .unwrap()
            .contains("정상 작동이 확인될 때까지"));
        assert!(value["en"]["authorization"].is_null());
        assert!(value["ko"]["authorization"].is_null());
    }

    #[test]
    fn renderer_has_no_html_sinks_network_bridges_or_action_controls() {
        for forbidden in [
            "innerHTML",
            "outerHTML",
            "insertAdjacentHTML",
            "document.write",
            "onclick",
            "__TAURI",
            "fetch(",
            "XMLHttpRequest",
            "WebSocket",
            "localStorage",
            "sessionStorage",
            "location",
            "http:",
            "https:",
            "createElement('button')",
            "createElement('form')",
            "createElement('input')",
            "createElement('a')",
            "createElement('script')",
        ] {
            assert!(
                !RENDER.contains(forbidden),
                "unexpected renderer capability: {forbidden}"
            );
        }
        assert!(RENDER.contains("details.textContent = screen.message"));
    }

    /// Run explicitly after npm dependencies are installed:
    /// cargo test --locked --manifest-path src-tauri/Cargo.toml updater_screen::tests::scripts_execute_in_dom -- --ignored --nocapture
    /// This exercises a DOM implementation, not a packaged webview or VoiceOver.
    #[test]
    #[ignore = "requires Node and the repository's installed happy-dom dependency"]
    fn scripts_execute_in_dom() {
        use std::{
            io::Write,
            path::Path,
            process::{Command, Stdio},
        };

        let screens: Vec<_> = [
            Screen::Checking,
            Screen::Applying,
            Screen::Restarting,
            Screen::Recovery {
                message: HOSTILE.into(),
            },
            Screen::Recovery {
                message: String::new(),
            },
        ]
        .into_iter()
        .map(|screen| {
            json!({
                "script": script(&screen),
                "content": content(&screen),
            })
        })
        .collect();
        let fixtures = json!({
            "html": include_str!("../recovery/index.html"),
            "screens": screens,
        });
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut child = Command::new("node")
            .args(["--input-type=module", "--eval", DOM_TEST])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node is required for this explicit DOM test");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(fixtures.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "DOM test failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }

    const DOM_TEST: &str = r#"
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const fixtures = JSON.parse(readFileSync(0, 'utf8'));
const locales = [
    ['en-US', ['en-US'], 'en'],
    ['ko-KR', ['ko-KR'], 'ko'],
    ['en-US', ['ko-KR', 'en-US'], 'ko'],
    ['ko-KR', ['en-US', 'ko-KR'], 'en'],
    ['ko', [], 'ko'],
    ['KO-kr', [], 'ko'],
    ['fr-FR', ['fr-FR'], 'en'],
    ['kok-IN', [], 'en'],
    ['', ['ko-KR'], 'ko'],
    ['', [], 'en'],
];
let renders = 0;
for (const [language, languages, locale] of locales) {
    const window = new Window({ url: 'https://tauri.localhost/index.html' });
    try {
        const { document } = window;
        document.write(fixtures.html);
        const originalStyle = document.head.querySelector('style').textContent;
        Object.defineProperty(window.navigator, 'language', { value: language });
        Object.defineProperty(window.navigator, 'languages', { value: languages });
        window.fetch = () => { throw new Error('network access forbidden'); };
        window.__TAURI__ = { core: { invoke: () => { throw new Error('IPC forbidden'); } } };

        // Start with the existing server recovery's Retry control, then check
        // state transitions, repeat evaluation, and diagnostic removal.
        const retry = document.createElement('button');
        retry.id = 'gajae-retry';
        retry.textContent = 'Retry';
        document.body.append(retry);
        for (const fixture of [...fixtures.screens, ...fixtures.screens.slice().reverse()]) {
            const previousRoot = document.querySelector('main[data-updater-screen]');
            window.eval(fixture.script);
            renders += 1;
            const { content } = fixture;
            const copy = content[locale];
            const recovery = content.kind === 'recovery';
            const main = document.querySelector('main');
            const heading = document.querySelector('h1');
            const status = document.querySelector('[role]');
            assert.equal(document.body.children.length, 1);
            assert.equal(document.querySelectorAll('main').length, 1);
            assert.equal(main.dataset.state, content.kind);
            assert.equal(main.dataset.updaterScreen, content.kind);
            assert.equal(document.querySelectorAll('main[data-updater-screen]').length, 1);
            assert.equal(document.querySelector('main[data-updater-screen]'), main);
            assert.equal(main.isConnected, true);
            if (previousRoot) {
                assert.notEqual(previousRoot, main);
                assert.equal(previousRoot.isConnected, false);
            }
            assert.equal(document.documentElement.lang, locale);
            assert.equal(document.title, copy.heading + ' — ' + content.product);
            assert.equal(heading.textContent, copy.heading);
            assert.equal(document.activeElement, heading);
            assert.equal(status.getAttribute('role'), recovery ? 'alert' : 'status');
            assert.equal(status.getAttribute('aria-live'), recovery ? 'assertive' : 'polite');
            assert.equal(status.getAttribute('aria-atomic'), 'true');
            assert.equal(status.getAttribute('aria-labelledby'), heading.id);
            assert.equal(document.head.querySelector('style').textContent, originalStyle);
            for (const key of ['body', 'authorization', 'data', 'manual']) {
                const paragraph = document.querySelector('[data-copy="' + key + '"]');
                assert.equal(paragraph?.textContent ?? null, copy[key]);
            }
            assert.equal(document.body.querySelector('button, a, form, input, textarea, select, iframe, img, script, [href], [src], [onclick]'), null);
            assert.equal(window.injected, undefined);
            for (const element of document.body.querySelectorAll('*')) {
                for (const attribute of element.attributes) {
                    assert.ok(!attribute.name.startsWith('on'), 'no inline handlers');
                }
            }
            const details = document.querySelector('pre');
            if (recovery && content.message) {
                assert.equal(details.textContent, content.message);
                assert.equal(details.children.length, 0);
                assert.equal(details.dir, 'auto');
                assert.equal(details.tabIndex, 0);
                assert.equal(document.getElementById(details.getAttribute('aria-labelledby')).textContent, copy.details);
                assert.ok(!status.contains(details), 'untrusted diagnostics are not auto-announced');
                assert.equal(details.style.whiteSpace, 'pre-wrap');
                assert.equal(details.style.overflowWrap, 'anywhere');
                details.focus();
                assert.equal(document.activeElement, details);
            } else {
                assert.equal(details, null);
                assert.equal(document.querySelector('h2'), null);
            }
        }
        const previousRoot = document.querySelector('main[data-updater-screen]');
        document.body.replaceChildren(document.createElement('main'));
        assert.equal(previousRoot.isConnected, false);
        assert.equal(document.querySelector('main[data-updater-screen]'), null);
    } finally {
        await window.happyDOM.close();
    }
}
console.log('Passed ' + renders + ' DOM renders: root markers/identity, locale selection, state transitions, live regions, focus, inert diagnostics, and no action controls.');
"#;
}
