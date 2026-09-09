# macOS 자동 업데이트 구현 계획

> 2026-09-09 정책 변경: 이 문서의 자동 다운로드·다음 실행 자동 설치 정책은
> 사용자 요청에 따라 폐기됐다. 현재 구현은 자동으로 새 버전만 확인하고,
> 왼쪽 아래 Settings 위의 **업데이트** 버튼을 눌렀을 때만 다운로드·안전한
> 재시작을 진행한다. 아래는 역사적 계획이며 현재 계약은
> [DESKTOP-CLICK-UPDATE.md](../DESKTOP-CLICK-UPDATE.md)를 따른다.

상태: 구현 승인 전 계획 초안. 제품 코드·키·릴리스·배포 환경 변경 없음.
범위: macOS 데스크톱부터. 현재 배포 대상에 맞춰 Apple Silicon(arm64)을 1차 대상으로 한다. Intel/universal, Linux, Windows, 웹 셀프호스트 서버 업데이트는 제외한다.

## 1. 사용자 경험과 기본 정책

목표는 새 배포를 앱이 알아서 내려받고 적용하는 것이다. 채팅 도중 갑자기 종료시키는 기능이 아니다.

- 정식 배포 앱에서 자동 확인·다운로드를 기본 활성화한다. 설정 > 정보에 끄기와 수동 확인을 제공한다.
- 서버가 정상 기동한 뒤 최초 확인, 이후 6시간 간격에 작은 jitter를 둔다. 절전 복귀 때는 마지막 확인 시각을 기준으로 중복 요청을 합친다. 네트워크 실패는 제한된 backoff로 재시도하고 앱 실행을 막지 않는다.
- 다운로드·서명 검증은 백그라운드에서 한다. 앱 사용 중에는 번들 파일을 교체하지 않는다.
- 검증 완료한 업데이트는 **다음 정상 앱 시작 때, 서버·worker를 시작하기 전에 자동 적용**한다. 실행 중에 임의로 자동 재시작하지 않는다.
- 바로 적용하려는 사용자를 위해 설정 화면에 `업데이트 후 재시작`을 제공한다. 전체 실행 상태가 안전하지 않으면 이유를 표시하고 적용을 보류한다. 강제 종료 옵션은 제공하지 않는다.
- 설정 > 정보에 현재 앱 버전, 데스크톱 빌드 버전, 업데이트 버전, 진행률, 대기 사유, 재시도, 릴리스 노트를 표시한다. 채팅 입력줄에는 버튼이나 상시 배너를 추가하지 않는다. 설치 준비 완료 안내는 한 번만 표시한다.
- 수동 확인은 자동 업데이트를 꺼도 가능하다. 자동 업데이트를 끄면 예약 설치도 취소하며, 수동 적용은 별도 명시적 동작이다.
- 베타 설치는 베타와 정식 릴리스를, 정식 설치는 정식 릴리스만 받는다. 더 낮거나 같은 데스크톱 버전은 설치하지 않는다. 1차에는 채널 전환 UI를 추가하지 않는다.
- 이미 배포된 updater 없는 beta.9는 원격으로 이 기능을 받을 수 없다. **updater가 들어간 최초 버전은 DMG로 한 번 설치해야 한다.** 그다음 배포부터 자동 업데이트한다.

이 정책과 arm64 우선 범위는 본 계획의 권장 기본값이다. 구현 승인은 이 기본값까지 포함하는 것으로 정리한다.

## 2. 확인한 현재 구조

| 근거 | 현재 상태 / 영향 |
| --- | --- |
| `src-tauri/Cargo.toml` | Tauri `=2.6.0`, Rust 최소 `1.85`, updater 의존성 없음. 최신 updater를 그대로 추가할 수 있다고 가정하면 안 된다. |
| `src-tauri/tauri.conf.json` | DMG 배포, 외부 server binary와 `server-payload` 포함. 기본 signingIdentity는 ad-hoc이며 배포 파이프라인에서 별도 서명한다. |
| `src-tauri/scripts/tauri.mjs` | `package.json.desktopVersion`을 Tauri version에 주입하고 Cargo version과 일치를 검사한다. |
| `package.json` | 제품 버전 `2.0.0-beta.9`, desktopVersion `0.2.3`. 두 버전은 서로 다른 용도다. |
| `.github/workflows/release.yml` | arm64 앱 빌드 → Developer ID 서명 → 앱 notarize/staple → DMG → DMG notarize/staple. 현재 desktop 허용 산출물은 DMG와 checksum 두 개뿐이다. |
| `scripts/release/LOCAL-RELEASE.md`, `local-release.mjs` | 로컬 서명 빌드를 검증한 기존 draft만 명시적으로 publish하는 별도 경로가 있다. CI만 바꾸면 로컬 릴리스는 빠진다. |
| `src/hooks/useVersionCheck.ts` | GitHub `releases/latest` 기반 알림뿐이며 설치 기능은 없다. 숫자 분할 비교는 beta.9 → beta.10 같은 prerelease 비교에 적합하지 않다. |
| `src/components/settings/view/tabs/AboutTab.tsx` | 기존 버전 표시·릴리스 링크가 있다. 데스크톱 업데이트 UI는 이 위치를 확장한다. |

공식 Tauri updater는 서명이 필수이며 macOS 업데이트 입력은 DMG가 아닌 `.app.tar.gz`다. 다운로드와 설치 API가 분리돼 있으므로 앱 사용 중 다운로드만 하고 설치를 미룰 수 있다. 공식 문서에서 확인한 최신 updater 2.11.0은 Tauri ^2.10을 요구한다. 현재 정확히 고정한 Tauri 2.6과 바로 결합하지 않는다.

## 3. 아키텍처 결정

### 3.1 네이티브가 업데이트를 소유

- Tauri 공식 Rust updater를 사용한다. 자체 앱 교체기·shell 다운로드 설치기를 만들지 않는다.
- Rust update coordinator가 확인, 다운로드, 검증, staging, 설치, 재시작 상태의 유일한 소유자다. React는 제한된 조회/설정/수동 확인/재시작 요청만 보낸다.
- 브라우저·Tailscale 웹 접속에는 네이티브 업데이트 권한과 UI를 노출하지 않는다. `window` 속성 존재만으로 권한을 판단하지 않는다.
- 현재 loopback SPA는 의도적으로 Tauri IPC 권한이 없다. 이를 유지한다. UI는 기존 desktop bootstrap cookie/Origin 인증을 거쳐 sidecar의 제한된 update 요청을 사용하고, Rust coordinator와 sidecar는 실행별 비밀값으로 인증된 전용 제어 채널을 추가한다. Rust가 비밀값을 보관하고 sidecar 소유권을 확인해야 하며 브라우저로 비밀값을 전달하지 않는다.
- 서버는 native 상태의 전달자일 뿐 설치 권한을 갖지 않는다. native가 허용된 요청 종류·현재 상태·실행 소유권을 재검증한다. 임의 URL, 설치 경로, 키, 명령행 인자는 프런트엔드에서 받지 않는다. updater plugin 권한이나 remote IPC capability를 SPA에 추가하지 않는다.
- Linux 빌드와 QA/dev 실행은 자동 다운로드/설치 대상에서 제외한다. 별도 업데이트 QA 빌드는 격리된 HOME, 전용 키와 피드로만 시험한다.

### 3.2 릴리스·버전 계약

- 업데이트 비교 기준은 Tauri가 실제 사용하는 `desktopVersion`이다. 제품 버전은 사용자 표시와 GitHub 태그에 유지한다.
- 모든 updater 대상 배포는 desktopVersion도 반드시 증가시킨다. CI와 로컬 publisher가 이전 공개 배포와 비교해 중복·역행을 차단한다.
- 1차는 기존 GitHub Releases를 배포 원본으로 사용한다. 새 업데이트 서버는 운영하지 않는다.
- 네이티브가 공개 releases 목록을 제한된 pagination과 ETag 캐시로 조회한다. draft 제외, 허용 채널, `darwin-aarch64` 대상, 검증 가능한 updater manifest가 있는 후보만 취급한다. `/releases/latest` 하나로 베타 채널을 처리하지 않는다.
- 릴리스별 정적 `desktop-update.json`에 표준 Tauri 필드 `version`, `notes`, `pub_date`, `platforms.darwin-aarch64.{url,signature}`와 제품 버전/채널/최소 OS 정보를 둔다. `version`은 desktopVersion이다.
- 선택된 release tag의 immutable asset URL만 사용한다. repository는 `shared/productIdentity.js`의 canonical identity에서 유도하고 네이티브 생성 설정과 identity 검증에 연결한다. UI 문자열을 URL 권한으로 사용하지 않는다.
- HTTPS 강제, 다운로드 redirect 정책도 검증한다. 업데이트 서명은 내장 공개키로 확인한다. checksum은 무결성 보조 자료이며 서명 대체물이 아니다.
- 공개 metadata를 artifact 서명으로 보호된 것처럼 취급하지 않는다. 검증된 archive 내부의 번들 버전·identifier·architecture·최소 OS가 선택한 manifest와 일치해야 한다. 이 검사는 안전한 archive 검증 방식으로 수행하고 직접 설치기를 만들지 않는다.

### 3.3 정확한 서명 순서

1. 동일 source commit에서 앱과 포함된 Node/Bun/native/server payload를 빌드한다.
2. 기존 절차대로 Developer ID 서명, notarization, stapling, 복사 후 검증을 완료한다.
3. **최종 `.app`에서** updater `.app.tar.gz`를 생성한다.
4. 그 최종 archive를 별도의 Tauri updater private key로 서명하고 `.sig`, checksum, manifest를 생성한다.
5. 기존 DMG와 새로운 updater archive가 동일 제품/desktop 버전·번들을 담는지 검증한다.
6. 모든 asset을 draft에 업로드하고 기존 CI/로컬 acceptance를 확장해 검증한 뒤에만 publish한다.

현재 Tauri build 직후 만든 updater archive는 이후 Developer ID 서명/stapling 이전 바이트일 수 있다. `createUpdaterArtifacts: true`만 켜서 그 초기 산출물을 게시하면 안 된다. Tauri 호환 포맷의 최종 archive 생성·서명 단계를 release tooling에 명시한다.

Updater 개인키는 Apple Developer ID와 별개다. 보호된 release secret 또는 기존 로컬 보안 저장소에서만 사용하고 repo·앱·로그에는 넣지 않는다. 생성·백업·복구 책임자가 정해져야 첫 updater-enabled 공개 배포를 할 수 있다. 키 유실 시 기존 설치에 업데이트를 더 배포하지 못할 수 있으므로 수동 재설치 복구 절차를 문서화한다.

### 3.4 상태와 안전한 적용

상태 흐름:

`idle → checking → downloading → verifying → ready → applying → restarting → idle`

`deferred`는 설치 보류, `error`는 재시도 가능한 실패를 별도 표시한다. 중복 확인·다운로드·설치는 coordinator의 단일 작업으로 합친다.

- staging은 앱 번들 밖 전용 사용자 cache에 보관하고 원자적 rename으로 완료를 기록한다. 불완전 다운로드는 설치 후보가 아니다.
- 재시작 뒤 cache를 신뢰하지 않고 **실제 설치할 동일 bytes의 서명을 재검증**한다. Tauri `download()`의 이전 성공이 파일 재로드 후 `install()`까지 보장한다고 가정하지 않는다. 선택한 plugin의 재검증 API가 없으면 유지보수되는 동일 서명 검증 라이브러리를 사용한다.
- 시작 시 single-instance/소유권 확보 후, 이전 소유 server/process가 없음을 확인한 뒤에만 적용한다. 일반 서버 시작과 updater 적용이 경합하지 않게 한다.
- 시작 적용 위치는 `main.rs`의 `setup`에서 instance lock 획득 이후, `supervisor::start()` 이전이다. Tauri 2.6의 main-thread `restart()`는 종료 callback을 건너뛸 수 있으므로 sidecar 시작 이후에 호출하지 않는다. 업데이트 재실행의 자식이 부모 lock을 보고 조용히 종료하는 race를 bounded lock handoff/retry로 해결하고, lock 소유권 공백에 일반 두 번째 instance가 끼는 경우도 검증한다.
- 선택 updater의 `Update` 생성에 온라인 `check()`가 필요한지 P0에서 확인한다. 필요한 경우 시작 시 짧은 timeout으로 staged 버전과 동일한 manifest를 재확인하고, offline이면 기존 앱을 시작하며 적용을 미룬다. 다운로드 완료가 곧 오프라인 다음 실행 설치 보장이라는 의미는 아니다.
- 실행 중 `업데이트 후 재시작`은 백엔드의 전체 실행 상태와 원자적인 새 작업 admission 차단이 필요하다. 보고 있는 채팅의 `isProcessing`만으로 idle을 판정하지 않는다.
- 준비 중 worker, delegated task, goal 자동 continuation, 도구 실행, 대기 중 사용자 승인, queued send, 자동화 및 PTY 활동 등 restart 영향 범위를 포함한다. 모르는 상태·timeout·소유권 불명은 설치 불가다.
- React draft/첨부 및 필요한 UI 상태를 저장한 뒤 backend drain을 확인한다. drain은 설치 직전까지 유지하며 새로운 요청은 조용히 버리지 않고 명시적으로 재시도/보류 응답을 준다.
- 기존 supervisor 종료 및 단일 인스턴스 경로를 재사용한다. 업데이트 전용 무조건 kill 또는 별도 server spawn 경로를 만들지 않는다. 안전 종료 실패 시 업데이트를 보류한다.
- `SidecarLifecycle::begin_shutdown()`의 현재 shutdown fence는 되돌리는 API가 없다. 새 작업 drain은 이 fence 진입 전에 취소 가능해야 한다. fence 진입 뒤 설치 실패 시 기존 앱의 정상 재실행 또는 recovery로 이어지는 명시적 경로를 설계하고, 단순히 `supervisor::start()`를 다시 호출해 복구된다고 가정하지 않는다.
- 현재 macOS Cmd-Q/Apple quit는 preventable `ExitRequested`를 거치지 않을 수 있어 `RunEvent::Exit`의 bounded `blocking_shutdown()`이 보완한다. 이 종료 callback 안에서 업데이트 다운로드·설치를 수행하지 않는다. 서버 종료 대기 30초 초과를 설치 안전 확인으로 취급하지 않는다.
- 재시작한 앱은 desktopVersion, packaged server `/health`, 번들 런타임 기동을 확인하고 성공 상태를 기록한다. 실패 시 recovery UI와 진단/수동 재설치를 제공하고 무한 재설치·재시작 루프를 막는다.
- `/health`의 버전은 새 서버가 보고한 값끼리만 비교하지 않고 build-time expected payload version과 비교한다. bundle identifier와 영속 `desktop-port`를 유지해 같은 WebKit origin의 설정·draft가 보존돼야 한다. 업데이트로 재실행할 때 macOS Apple Event deep link도 저장·한 번만 재전달한다.

### 3.5 실패·지원 경계

- 오프라인, 429, 잘못된 manifest, signature mismatch, 디스크 부족, 다운로드 중 종료: 현재 버전으로 계속 사용하며 자동 재시작하지 않는다.
- DMG mount, App Translocation, 읽기 전용 설치 위치, 다른 소유자의 설치: 자동 적용을 차단하고 정상 설치 위치로 이동/관리자 설치 안내를 제공한다. 자동 sudo 또는 권한 상승은 하지 않는다.
- 업데이트는 앱 번들만 교체한다. `~/.gajae-app`, agent 설정/인증, transcript와 사용자의 Git worktree는 삭제·이동하지 않는다.
- 1차는 **설치 이후 건강 상태에 따른 자동 버전 rollback을 보장하지 않는다.** 플러그인의 설치 실패 복구 범위는 실제 선택 버전 소스로 확인한다. 새 버전의 데이터 변경까지 되돌리는 기능은 별도 설계가 필요하다. 실패 시 업데이트 재시도 차단, 기존 데이터 보존, 명시적인 수동 복구가 acceptance다.

## 4. 구현 순서와 완료 조건

### P0 — 호환성·계약 확정

대상: `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `src-tauri/scripts/tauri.mjs`, `scripts/release/desktop-platforms.mjs`.

- 공식 updater 중 보안상 적합하고 현재 Tauri/Rust와 호환되는 정확한 버전을 선정한다. 안전한 호환 버전이 없으면 Tauri/runtime/Rust 업그레이드를 같은 단계의 명시적 선행 작업으로 포함한다.
- 버전 비교, macOS 최소 버전, artifact 포맷, install의 실패 복구·캐시 재검증·재시작 동작을 선택 버전 기준으로 확인한다.
- 전용 QA key로 격리된 A → B bundle 교체를 검증한다. 개인키 생성과 공개 배포는 별도 승인된 운영 단계다.
- 완료: 정상 교체, 잘못된 키/서명 거부, 지원하지 않는 OS/arch 거부를 증명하고 의존성 잠금을 확정한다. 이 단계 실패 시 뒤 단계 설치 구현을 진행하지 않는다.

### P1 — 릴리스 산출물과 배포 검증

대상: `.github/workflows/release.yml`, `scripts/release/local-release.mjs`, `local-release-macos.mjs`, 기존 관련 테스트, 신규 updater archive/manifest 생성 스크립트.

- 최종 서명된 앱에서 archive/signature/manifest를 생성한다.
- 현재 두 개 desktop asset/전체 네 개 asset 제한을 정확한 새 allowlist로 갱신한다. 임의 파일 허용으로 완화하지 않는다.
- CI와 로컬 draft verifier 모두 최종 bytes, 서명, 버전 매핑, OS/arch, DMG와 archive의 동등성을 확인한다.
- 완료: asset 누락, 버전 역행, 다른 bundle, 잘못된 signature, 미서명 앱은 publish 불가. 공개 release 수정 없이 격리 fixture로 실패 경로를 검증한다.

### P2 — 네이티브 다운로드와 다음 시작 자동 적용

대상: 신규 `src-tauri/src/updater.rs`, `main.rs`, `supervisor.rs`, `lifecycle.rs`, 네이티브 테스트.

- coordinator, 채널별 release 선택, check/backoff, staging/revalidation, 시작 시 적용을 구현한다.
- single-instance와 supervisor ownership을 지키고 플러그인 설치 실패 시 정상 실행 또는 recovery로 안전하게 분기한다.
- 완료: 이전 실행 중 번들 변경 없음, 재기동 후 최종 bytes 재검증, 올바른 버전/서버 기동, 실패 반복 루프 없음.

### P3 — 안전 재시작과 좁은 UI bridge

대상: `desktop_origin.rs`, `main.rs`, capabilities, backend 작업 admission/상태 경계, 신규 desktop update bridge와 테스트.

- backend runtime 소유자 기반 prepare/commit/cancel drain 계약을 구현한다. 정확한 backend 파일은 실행 전 admission 경로를 조사해 이 단계의 구현 작업을 분할한다. 웹소켓/REST/자동화/goal continuation 모두 같은 차단 경계에 들어가야 한다.
- 기존 desktop bootstrap cookie/Origin 방어를 재사용하는 제한된 SPA→sidecar 경로와, native 소유 실행별 인증 채널을 구현한다. 현재 notification bridge의 프런트엔드 형태는 참고하되 이미 native 양방향 IPC가 있다고 가정하지 않는다. 일반 웹 인증으로는 update 요청을 할 수 없다.
- 완료: idle 확인 직후 새 작업 요청 race에서도 작업 중 재시작 없음. Tailscale 웹, 외부 origin, 다른 window의 설치 요청은 거부. lifecycle 종료·재시작 및 단일 인스턴스 테스트 통과.

### P4 — 설정 UI와 버전 표시 통합

대상: `AboutTab.tsx`, `useVersionCheck.ts`, desktop update hook/bridge, 관련 locale 및 DOM 테스트.

- 기존 About 화면을 확장한다. 데스크톱에서는 native snapshot만 업데이트 상태의 source of truth로 쓴다.
- 웹에서는 설치 UI를 표시하지 않는다. 기존 웹 버전 안내를 유지하되 prerelease 숫자 분할 비교는 표준 SemVer로 교체해 모순된 최신 버전 안내를 없앤다.
- 진행률 unknown-size 다운로드, offline, deferred, manual retry, 자동 업데이트 off, restart pending 상태를 테스트한다.
- 완료: 채팅 입력 UI에 새 controls 없음. 키보드·한/영 UI, 창 크기 변화, 오류 접근성 검증. 브라우저 성공을 네이티브 설치 검증으로 보고하지 않는다.

### P5 — 실제 서명된 두 버전으로 최종 수용

- 동일 테스트 계정의 격리 데이터로 서명·공증된 A → B를 검증한다. DMG 초기 설치와 updater archive 경로를 각각 검증한다.
- 생산 HOME/실제 대화/실제 배포 release를 실험 대상으로 사용하지 않는다.
- `npm run verify`에 더해 `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo test --locked --manifest-path src-tauri/Cargo.toml` 및 실제 macOS updater e2e를 수행한다. 의존성 선택에 따라 추가 Rust lint를 포함한다.
- packaging, signature/notarization, updater install, 데이터 보존, GUI acceptance 증거를 분리한다.
- 기존 `docs/DESKTOP-TAURI-VERIFICATION.md`, `scripts/release/LOCAL-RELEASE.md`, signing-readiness 문서와 release acceptance 안내를 수정한다.
- 이후 승인된 최초 updater-enabled DMG를 배포하고, 다음 별도 버전으로 공개 채널의 실제 자동 업데이트를 검증한다. 첫 버전을 배포했다는 사실만으로 자동 업데이트 성공을 선언하지 않는다.

## 5. 필수 검증 매트릭스

| 상황 | 통과 조건 |
| --- | --- |
| beta.9 → beta.10, beta → stable, stable → beta | 제품 SemVer와 monotonic desktopVersion 적용; stable이 beta를 받지 않음 |
| 같은/낮은 desktopVersion, 잘못된 OS/arch | 다운로드/설치 후보에서 제외 |
| 손상 archive, 다른 키, cache 변조, metadata/bundle 버전 불일치 | 설치 거부, 현재 앱과 데이터 보존 |
| 정상 idle 재시작 | draft 저장, admission 차단, 소유 server 종료, 새 버전 server 정상 기동 |
| 실행/승인대기/queued/goal continuation/PTY 및 상태 timeout | 적용 보류, 실행 중단 없음 |
| drain 직후 새로운 작업·다른 웹클라이언트 요청 | 작업 시작과 설치가 동시에 성공하지 않음 |
| 앱 중복 시작, update 중 deep link, QA profile | 소유 instance만 적용, 전달 보존, QA가 생산 설치를 바꾸지 않음 |
| 다운로드/검증/설치 각 단계 종료 또는 전원 중단 | partial 상태를 완료로 취급하지 않음; 선택 plugin의 복구 경계를 실제 입증 |
| 429/offline/timeout/디스크 부족/권한 부족 | 무한 재시도·무한 재시작 없음, 명확한 상태와 수동 복구 |
| 정상 업데이트 전후 | 사용자 인증·설정·프로젝트·transcript·draft 보존, runtime manifest 및 `/health` 정상 |
| updater 없는 기존 beta.9 | 최초 DMG 설치 필요 안내, 자동 업데이트 가능하다는 잘못된 안내 없음 |

## 6. 승인·실행 경계와 참고

이 문서는 계획이다. updater 설치·의존성 변경·서명키 생성·GitHub secret 변경·commit/push·릴리스 게시를 실행하지 않았다. 저장소에 있던 채팅 UI 변경과 실행 중 preview는 본 계획에서 변경하지 않는다.

실행 시작 전에 확정할 운영 항목: updater 개인키 보관·백업 담당, 기존 로컬 Developer ID/공증 경로 사용 여부와 CI secret 준비 상태. 민감한 값을 채팅이나 문서로 수집하지 않는다. 준비되지 않으면 로컬 fixture 구현은 가능하지만 공개 배포는 차단한다.

참고:
- https://v2.tauri.app/plugin/updater/
- https://docs.rs/tauri-plugin-updater/2.11.0/tauri_plugin_updater/struct.Update.html
- `src-tauri/tauri.conf.json`, `src-tauri/scripts/tauri.mjs`
- `.github/workflows/release.yml`
- `scripts/release/LOCAL-RELEASE.md`
