# macOS 자동 업데이트 — 남은 작업 인계

## 2026-09-07 재개: 준비 경로 구현

사용자가 이 작업에서 구현 재개와 Astra xhigh 병렬 작업을 승인했다. 아래
14:36 중단 기록은 과거 상태이며, 이번 준비 경로의 결과로 대체되는 항목은
여기에 명시한다. 기존 GJC 원장/완료 영수증은 편집하지 않았다.

- `updater_manifest.rs`의 컴파일 오류·fixture 경로와 빌드 바인딩의 정상 GitHub
  slug 거부 오류를 수정했다. Cargo.lock을 기존 고정 버전으로 오프라인 동기화했다.
- `updater_archive.rs`: 추출하지 않는 gzip/tar/PAX 검사, 전체 파일/모드/해시/링크
  inventory, Info.plist·payload·런타임 closure·arm64 shell 검사.
- `updater_discovery.rs`: 3×30 페이지/30초 단위의 재개 가능한 탐색, 관찰한 최대
  desktop 버전, 불완전 탐색 표시, asset ID 재확인, 제한된 HTTPS redirect/다운로드,
  Retry-After. GitHub의 원자적 스냅샷이나 전역 최신 버전 증명은 아니다.
- `updater_store.rs` / `updater_signature.rs`: owner-only/descriptor 기반 캐시,
  exclusive stage와 fsync/atomic ready 게시, 취소된 stage 정리, crash orphan 용량
  상한, 실제 Minisign 검증. 재로드 시 같은 bytes의 서명·digest·전체 inventory를
  다시 확인한다. cache ready는 설치 허가나 설치 성공이 아니다.
- `updater.rs`: 단일 준비 owner/generation, opt-out 영속화와 취소, 수동 확인과
  설치 동의 분리, 6시간±10분 주기/1·5·30분 재시도, wake coalescing. 서버 health와
  navigate 성공 뒤에만 연결했고 서버 실패/종료 시 현재 준비 generation을 취소한다.
- `updater_binding.rs`: disabled/일반 dev/QA 바인딩 불일치는 업데이트 I/O 전 거부.
  QA root뿐 아니라 실제 실행 app와 데이터 root도 비교한다. QA HTTPS CA는 고정
  `${GJC_UPDATE_QA_ROOT}/updater-ca.pem`의 owner-only 공개 인증서를 **빌드 시** 읽어
  컴파일에 포함한다. 런타임 CA 입력이나 TLS 검증 비활성화는 없다.
- `expected_payload.rs`: 설치 payload의 package와 런타임 manifest를 빌드에 결합한
  독립 기대값과 비교한 뒤에만 서버를 시작한다. ready/health의 기존 독립 버전
  검증도 유지한다.

### 아직 연결하지 않은 기능

**전체 자동 업데이트 기능은 미완료다.** `installation_available`은 false이며
production updater 빌드를 활성화하거나 공개 릴리스하지 않았다. G001의 실제
OS 승인/취소·writer 종료·macOS 13 및 Linux 검증, 다음 시작 설치/attempt
writer/resolver/복구, G003의 main-view-bound bridge·전체 producer admission·안전
재시작, Settings/About UI, G004의 실제 서명된 A→B/GUI/사용자 데이터 보존 검증은
그대로 남아 있다. 일반 브라우저나 원격 SPA에 새 native capability를 주지 않았다.

준비 owner의 설정/수동 확인 메서드는 내부 계약 및 테스트만 있으며, 아직 사용자
설정 화면이나 API에 노출하지 않았다. bridge/UI 완료로 오인하지 않는다. 설치를
연결하기 전에 아래 G001/G003 차단 조건을 충족해야 한다.

### 이번 재개 검증

- 전체 `npm run verify` 통과(기존 채팅 UI 변경이 섞인 로컬 작업 트리 기준).
- 릴리스 도구: 234 tests, 224 pass, 10 Linux-only skip, 0 fail.
- desktop locked Rust tests: 164 pass + 1 opt-in archive fixture ignore,
  build-binding 9 pass, probe 19 pass. 별도 real archive fixture는 실제 실행해 통과했다.
  `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` 통과.
- 실제 private-CA HTTPS 테스트: 기본 trust client는 UnknownIssuer로 거부하고
  HTTP 요청 0, 컴파일용 CA를 추가한 client는 HTTP 요청 1로 성공했다. PEM/DER
  구문은 고정 WebPKI 파서로 검사한다. CA 자기서명/유효기간 인증 증명과는 구분한다.
- 독립 리뷰의 종료/ready 표시/owner retirement 경쟁 조건을 수정했다. 종료는
  cache fsync 잠금을 기다리지 않으며, snapshot은 epoch를 확인하고, retirement와
  겹친 healthy/수동 요청은 하나의 owner가 이어받는다. 관련 회귀 테스트 12개 통과.
- 기존 아카이브의 20,673개 inventory 항목을 JS 생산자와 읽기 전용으로 대조했다.
  이는 Apple 코드 서명·공증·모든 Mach-O의 OS floor·실제 설치/실행 증거가 아니다.
  대상은 기존 beta.9/desktop 0.2.3, SHA256
  `dda009d8e3d51a89fce3c61968fe386f1fcaad9954628aab4ea56ae6b8ffbe63`이다.
  그 fixture의 기대 floor는 역사적 Info.plist/shell 값 11.0이며 Bun의 13.0
  loader floor 불일치를 해결한 새 릴리스로 인정하지 않았다.
- 기존 채팅 UI/번역 변경은 수정하지 않았다. 실제 설치·인증창 실험·production
  signing/key provisioning·release publication은 실행하지 않았다.

QA root는 기존 `--qa-profile` 절차로 먼저 초기화하고 테스트 앱을 종료한 뒤,
그 root 안에 `updater-ca.pem`과 테스트 `.app`을 배치한다. 일반 QA의 nonempty
directory 보호를 우회하지 않는다. 인증서 fixture 테스트는 `openssl`을 사용하며
인증서/키는 소유한 임시 폴더 안에서만 생성·정리한다. OS trust store는 변경하지 않는다.

---

작성: 2026-09-07 14:36 KST. 사용자가 장시간 실행을 중단하고 **문서로 남은 작업만 인계**하도록 요청했다. 추가 구현·설치 실험·검증을 자동 재개하지 않는다. 완료 선언이 아니다.

## 재개 기준

- 기존 목표를 유지한다. G001 안전성 검증 미완료, G002 릴리스 도구 완료 기록 유지, G003 네이티브 수명주기/설정 미완료, G004 최종 실증 미완료.
- 원장: `.gjc/_session-01a076d3-db4a-760a-ae8e-1bad69cdb5b8/ultragoal/{goals.json,ledger.jsonl}`.
- 승인 기준: 같은 세션의 `plans/ralplan/01a076d3-db4a-760a-ae8e-1bad69cdb5b8/pending-approval.md` 및 참조된 `stage-03-revision.md`. 최종 SHA `60faa93543369cbfa326c8bfd8d6ff9f5b6e447c1fd60fb088e95a978221216a`. 미완결 stage04 리뷰를 승인 계획으로 바꾸지 않는다.
- 작업 트리에 채팅 UI·번역·릴리스·네이티브 변경이 섞여 있고 커밋되지 않았다. 일괄 되돌리기/스테이징/커밋 금지. 원본 `docs/plans/macos-auto-update.md`도 보존한다.
- 인계 시 `12-UpdaterArchive`, `15-ExpectedPayload`를 실제 paused 상태로 확인했다. 재승인 후 필요하면 같은 에이전트를 재개하고, 동일 작업을 새 에이전트에게 중복 배정하지 않는다.

## 1. 먼저 현재 미검증 변경을 확인

아래 코드는 작성됐지만 **이번 변경에 대한 부모 테스트·빌드·포맷·통합 검증은 아직 실행하지 않았다**. 과거 통과 결과를 적용하지 않는다.

| 파일 | 상태 / 남은 확인 |
|---|---|
| `src-tauri/src/updater_manifest.rs` | 엄격한 네이티브 매니페스트 파서 작성. 64KiB, 중복/미지 키, 날짜, 채널, 버전, 정규 URL 검증 테스트 미실행. |
| `shared/fixtures/desktop-update-manifest.json` | JS/Rust 공용 스키마 fixture. 서명은 구문 테스트용이며 실제 암호 검증 증거가 아니다. |
| `scripts/release/updater-artifacts.test.mjs` | 공용 fixture와 생산자 일치 테스트 추가, 미실행. |
| `src-tauri/src/main.rs` | macOS 파서 모듈 선언 추가. 준비 coordinator는 연결되지 않았다. |
| `src-tauri/{build.rs,Cargo.toml,update_build_binding.rs,tests/update_build_binding.rs}` | 빌드 바인딩 구현 및 후속 보완 중 정지. lock 갱신/컴파일/테스트 필요. |
| `src-tauri/src/updater_transport.rs`, `src-tauri/examples/updater_probe.rs` | 부모가 `fetch_response`, 제한된 Location/Retry-After, URL 토큰 오류 제거, `InvalidHeader` 및 테스트 추가. 새 API 사용처와 경고까지 확인 필요. |

인계 시 `src-tauri/src/{updater_archive,updater,updater_store}.rs`는 **존재하지 않음**을 확인했다. 특히 archive 담당자는 설계/조사 중 정지했으므로 구현 완료로 오인하지 않는다.

핵심 계약:

- `parse_manifest(bytes, &ProductIdentity { repository, artifact_prefix }) -> Result<Manifest, String>`.
- `Manifest`는 `semver::Version`, `Channel`, `minimum_system_version`, `archive_url`, `signature`, `commit`, `notes`, `pub_date`를 소유한다. 버전 비교는 `cmp_precedence` 사용.
- 현재 JS `strictVersion`은 build metadata를 거부한다. Rust도 이에 맞췄다. 이를 완전한 SemVer 입력 지원으로 과장하거나 생산자 의미를 무단 변경하지 않는다.
- 빌드 입력: `GJC_UPDATE_MODE`, `GJC_UPDATE_FEED_ORIGIN`, `GJC_UPDATE_PUBKEY`, `GJC_UPDATE_QA_ROOT`. 기본 disabled, production은 release/정규 origin/공개키 필수, QA는 컴파일에 바인딩된 소유자 전용 정규 임시 루트 필수. 실행 시 실제 `QaProfile` 일치 검증은 아직 연결되지 않았다.
- 후속 빌드 요청: `GJC_UPDATE_PRODUCT_NAME`, `GJC_UPDATE_PACKAGE_NAME` 출력 및 macOS 직접 의존성 tar `0.4.46`, flate2 `1.1.9`, plist `1.7.0`, sha2 `0.10.9`. 완료 여부를 파일에서 확인해야 한다. 새 버전 탐색 불필요.

## 2. G003: 설치와 분리된 준비 경로 구현

승인 계획은 설치 차단과 별개로 네이티브 다운로드/준비 작업을 허용한다. 다음 순서로 연결한다.

- [ ] 네이티브 읽기 전용 archive 검사: 유지보수되는 tar/gzip/plist 사용, 압축 250MiB/전체 확장 1GiB, 메타데이터/경로/멤버 한도, bounded PAX, 경로 탈출·중복·특수 파일·위험 링크 거부. 추출/설치는 하지 않는다.
- [ ] 전체 파일/모드/해시/링크 inventory와 서명된 Info.plist·payload package 정보를 매니페스트/제품 identity에 결합. arm64 확인. 코드 서명/설치 완료 증거와 구분한다.
- [ ] 정규 GitHub release discovery: 페이지/시간 제한, 관찰 후보 중 desktop 버전 최댓값, 불완전 조회를 ‘최신’으로 표시하지 않기, 채널 정책.
- [ ] native redirect 허용 정책, Retry-After, 제한된 archive 다운로드 → 실제 Minisign 검증 → 위 archive 검사.
- [ ] 소유자 전용 exclusive staging, fsync/원자적 게시, 전체 inventory와 digest/서명/릴리스·asset identity 보존. 재로드 시 다시 검증하고 파일 존재만 믿지 않기.
- [ ] 단일 실행 generation, 동의 영속화/취소, 건강한 서버 시작 후 실행, 주기·jitter·wake coalescing·재시도. disabled/일반 dev/바인딩 불일치 QA는 네트워크·쓰기 0.
- [ ] `supervisor.rs`의 실제 health 및 navigate 성공 뒤 `ready = true` 위치에 준비 경로만 연결. 설치·재시작·attempt 제거 권한은 추가하지 않는다.

## 3. G001 및 설치 통합의 차단 조건

- [ ] 선택된 updater **2.6.0**에서 실제 macOS 승인/취소 및 작업 종료·privileged writer 부재 증명. 2.11 분석을 선택 버전 증거로 사용하지 않는다.
- [ ] 취소 후 전체 A 무결성과 작업 종료가 모두 입증돼야 보류/시작 가능. 과거 auth runner의 `passed:true`는 사용자 취소나 writer 종료 증명이 아니다.
- [ ] durable attempt 게시/종료 판정, 모든 startup/Retry/quit/restart 경로의 소유권·gate. 현재 `updater_attempt.rs`는 존재 여부 차단 reader일 뿐 writer/resolver가 아니다.
- [ ] 불확실한 설치/승인 후 실패는 embedded recovery, 서버와 Retry 차단. timeout/heartbeat/health/version을 근거로 installer를 버리거나 재시도하지 않는다.
- [ ] 실제 macOS 13 실행 및 Linux locked build/패키지/런타임 inertness. macOS 26 측정과 정적 dependency 확인은 대체 증거가 아니다.

이 조건 전에는 product 설치 경로, attempt 자동 제거, 커스텀 installer/rollback을 연결하지 않는다.

## 4. 나머지 제품 기능 및 최종 검증

- [ ] 현재 main webview/navigation epoch에 결합된 인증된 native/backend bridge. 로그 프레임·복사 쿠키·브라우저·다른 창·이전 epoch는 권한 없음.
- [ ] HTTP/WS 및 모든 내부 producer의 zero-gap admission/accounting, 실제 업무 종료와 owned server exit 증명 후에만 수동 재시작. PTY/승인/위임/백그라운드/미확인 작업은 busy.
- [ ] Settings → About 및 embedded applying/recovery UI, 자동 업데이트 opt-out/진행/오류/메모, 실제 시스템 인증창 사전 안내. 채팅 입력창 컨트롤 추가 금지.
- [ ] 교정된 updater-enabled QA A→B에서 설치 전 서버 차단, 성공 후 독립 버전/health, 사용자 데이터·origin·draft·프로젝트/worktree 보존을 실제 확인.
- [ ] 전체 변경 합집합 검증, cleaner/architect/red-team/terminal critic, 기존 runbook 갱신. production key custody·Apple 서명·공개 릴리스는 별도 승인 사항.

## 재사용할 증거 / 재개 검증

기존 네트워크·서명·lock·릴리스 증거를 다시 만들지 말고 재사용한다. `dist-native/updater-evidence/p0-network-L07XVN/`에 크기/지연/TLS 거부 원시 기록과 해시가 있다. `untrusted-tls-manifest.json`은 unknown-CA, HTTP 요청/본문 0, 전체 A 불변 증거다. 모두 **G0 전체 완료나 실제 OS13/설치 종료 증거는 아니다**.

재개 시 현재 파일과 Cargo.lock을 먼저 맞춘 뒤 변경 합집합에 대해 실행할 출발점:

```sh
. "$HOME/.nvm/nvm.sh" && nvm use 22
node --test scripts/release/updater-artifacts.test.mjs
. "$HOME/.cargo/env"
env -u TAURI_CONFIG CARGO_NET_OFFLINE=true cargo +1.85.1 test --locked --manifest-path src-tauri/Cargo.toml
env -u TAURI_CONFIG CARGO_NET_OFFLINE=true cargo +1.85.1 test --locked --manifest-path src-tauri/Cargo.toml --example updater_probe
```

위 명령은 인계 중 실행하지 않았다. compile/unused 경고, 테스트 실패, 신규 계약 불일치를 먼저 해결하고 전체 gate와 실제 플랫폼 검증으로 확장한다. `/tmp` fixture feed는 종료됐을 수 있으며 TLS 인증서 만료를 확인한 후 사용한다. 설치·인증 실험을 자동 반복하지 않는다.
