# macOS 자동 업데이트 — 남은 작업 인계

## 최신 정책: 사용자가 누르는 업데이트

사용자 요청으로 자동 설치가 아닌 **Settings 위 업데이트 안내 → 클릭 시
다운로드·안전한 재시작** 방식으로 바꿨다. 자동 확인은 메타데이터 조회만 한다.
캐시나 automatic=true만으로 다음 실행에 설치하지 않으며, 정확한 targetId와
archive hash에 결합된 수동 intent만 기존 설치 검증에 진입한다. 클라이언트는
사이드바/About가 상태와 클릭을 공유하고 바쁨·실패·대상 변경을 자동 재시도하지
않는다. 이 변경은 기존 beta.11 설치본에 아직 반영되지 않았다. 현재 계약과
검증 경계: [DESKTOP-CLICK-UPDATE.md](DESKTOP-CLICK-UPDATE.md).

## 최신 사용자 테스트 설치본

`e28fa6d`의 beta.11 / desktop 0.2.5 수동 설치용 DMG를 Downloads에 전달했다.
앱·DMG 서명/공증/staple, 복사본 검사, 서버/데이터 보존 및 실제 격리 GUI의
정상 종료·재실행·초안/첨부 원본 바이트/설정 보존을 확인했다. 프로덕션 설치는
건드리지 않았다. **이 테스트 DMG의 updater는 disabled이며 공개 배포가 아니다.**
파일·해시·검증 범위: [RELEASE-BETA11-TEST.md](RELEASE-BETA11-TEST.md).

## 배포 키 로컬 준비 — 2026-09-09

사용자가 공식 보안 입력창으로 암호화 키를 생성하고 동일 비밀번호를 login
Keychain에 저장했다. 해당 Keychain 값으로 실제 Tauri 서명 및 native verifier
검증을 통과했고, 변조된 파일/다른 공개키는 거부됐다. 키는 프로젝트 밖에
보관하며 재생성하지 않는다. **독립 외장 백업은 아직 미완료**이고 공개 앱에
이 키를 연결하거나 배포하지 않았다. 위치·공개 fingerprint·검증 범위는
[UPDATER-KEY-CUSTODY.md](../scripts/release/UPDATER-KEY-CUSTODY.md)를 따른다.

## 최신 서명 QA 상태

`f69ec4f`의 동일 소스 release-mode A/B가 Developer ID 서명·공증·Gatekeeper
검증을 통과했다. **2026-09-09 실제 서명 A→B 자동 교체·후속 서버 health·일반
재실행까지 통과했다.** Off에서는 A를 유지하고 On에서는 정상 종료 후 다음
실행에 beta.11/0.2.5로 자동 교체한다. 수동 업데이트 버튼이나 QA 설치 플래그는
사용하지 않았다. 같은 origin, 대화/모델 설정, 초안/대기열/첨부 SVG의 전체
기록 바이트가 그대로이며 대기열 자동 전송은 없었다. 설치된 B의 서명·staple·
Gatekeeper도 다시 통과했다. QA 앱은 정상 종료하고 피드/모델/관측기만 중지했다.
fixture와 완료 journal은 보존하며 프로덕션 앱·공개 배포는 변경하지 않았다.
증거와 남은 승인·복구/OS13/키 보관·백업/공개 릴리즈 조건은
[DESKTOP-UPDATER-SIGNED-QA.md](DESKTOP-UPDATER-SIGNED-QA.md)에 있다.

후속 보안 검증에서 발견한 Multer/YAML 항목은 2.3.0 및 3.15.2/4.3.2로
갱신했다. ZIP final-leaf 취약점은 exact upstream PR160의 별도 해시 고정
backport로 처리하고 설치·audit·서버/desktop 패키징에서 확인한다. 적용 전·
변조·중첩 설치는 거부하며 기존 vendor-download 제한과 리뷰 기한도 유지한다.
실제 ZIP/패키징/audit 회귀 46개 및 clean npm ci 이후 전체 verify가 통과했다.
이 보안 변경은 위 signed f69ec4f 쌍 이후이므로 공개 후보는 새로 빌드해야 한다.

## 후속: 배포 binding과 자동 다음 실행 적용 연결

명시적 release-arm64 production binding과 exact QA binding이 같은 설치·재시작
경로를 사용하도록 연결했다. 기본 빌드의 disabled 상태, 실제 draft/runtime
admission, 소유 프로세스 종료, 캐시/서명/전체 앱 검증은 그대로다. 다음 실행의
적용 여부는 durable automatic 설정 또는 대상 hash가 일치하는 manual intent로
결정한다. QA 전용 추가 CLI 스위치는 더 이상 자동 설정의 실행 조건이 아니다.
Off + manual intent 없음은 설치하지 않는다. 이미 충족된 installation gate를
About에 pending으로 남기던 표시도 수정했다.

이는 production 앱을 활성화하거나 배포했다는 뜻이 아니다. 동일 소스의
Developer ID 서명·공증 QA A/B를 만든 뒤 실제 자동 경로를 검증한다. 현재
서명 identity 및 기존 `gajae-notary` 인증은 read-only 확인을 통과했다.
새 공증과 배포 조건의 완료 여부는 별도 실제 결과로 확인한다.

## 2026-09-08 후속: SDK 실제 종료 추적·알림 링크 보존·실패 정리

이전 `4fb43c2`의 Node 22/24, Linux 서버 아카이브와 desktop 빌드 및 Ubuntu
22.04/24.04 패키지/GUI 검사는 모두 통과했다. 아래는 그 다음 변경이며 공개
업데이트 활성화나 최종 signed A→B/배포 완료는 아니다.

- SDK 패치를 pristine 0.16.4의 **32개 파일**로 확장했다. 기본 제공 provider의
  실제 producer finally, iterator timeout loser와 활성화된 기본 WebSocket host의
  drain/retired owner/delivery 완료를 추적한다. 지원되는 일반 SDK 세션은 실제
  dispose join 뒤 complete/zero가 된다. generic notification host, opaque
  extension/provider, Grok 별도 구현, Cursor 내부 subtask, buffered credential
  callback, 미증명 custom transport/실패 factory는 여전히 unknown이다.
  자세한 범위: [SDK patch](../patches/gjc-sdk-lifecycle/README.md).
- `npm ci`가 32개 파일을 새 설치에 적용했고, 공식 `--update` 생성기로 tracked
  runtime manifest를 갱신했다. shared `sdkLifecyclePolicy.json`이 applier/worker/
  native parser의 공통 상한(32)을 소유한다. Manifest SHA-256:
  `7a1b8c20246ffbbe11e69656a0e0327f8d6c2ac8dff2333f5d56d6ec02f75e44`.
- macOS 알림 링크를 updater cache와 별도인 `desktop-deep-links/pending.json`에
  descriptor-relative atomic/fsync 방식으로 보존한다. 부팅/적용/복구 중에는
  이동하지 않으며 정상 main origin의 root 이동을 관측한 뒤 정확한 delivery
  epoch/prefix를 ACK한다. ACK 이전 종료는 다음 프로세스가 재전달한다. 전달과
  durable ACK 사이의 crash는 중복 root focus가 가능한 at-least-once 계약이다.
  URL shape/credential/query/fragment 검증과 16개 상한, 실패 시 보존은 유지한다.
- 실제 포트 충돌 QA에서 `ws`가 HTTP bind error를 전달하면서 초기화를 빠져나가
  자동화 소켓을 남기던 문제를 발견했다. 두 error emitter를 기다리는 listener와
  initializer join/조기 signal handler/실패 cleanup을 연결했다. 부팅 전 실패는
  새 job mutation을 시작하지 않는다. 자동화 정리 미확인도 정상 exit로 감추지 않는다.

검증:

- `/private/tmp/gajae-sdk32-verify-promotion.log`: 전체 verify exit 0.
  실제 설치 SDK 계약 104 pass/선택적 live 1 skip, lifecycle wrapper도 통과.
  이전 manifest hash 미갱신 및 import-order 실패 로그는 별도로 보존했다.
- `/private/tmp/gajae-server-startup-failure-tests.log`: 10 pass. 실제 HTTP/ws와
  실제 index initializer를 함께 실행해 bind 실패 시 소유 Unix socket 정리를 확인.
- `/private/tmp/gajae-deep-link-qa.cgeQ8X/native-sdk32.log`: native 318 pass,
  build-binding 10 pass, 6 ignored(전용 child helper는 부모 테스트가 별도 실행).
  같은 폴더의 `clippy-sdk32.log`도 통과했다.
- 같은 폴더의 `payload-sdk32.log`: fresh staging에서 32개 patch 적용과 out-of-tree
  packaged smoke 통과. **이 앱은 debug/ad-hoc QA이며 signed release 증거가 아니다.**

실제 GUI: 격리 root `gajae-update-qa-c29Vlg`, origin `127.0.0.1:61106`.
초기 OS URL activation은 queued 1 → delivered 1로 처리됐다. 포트 충돌 상태에서
남긴 링크는 recovery 중 전달되지 않았다. 수정 전 실패가 남긴 `a.sock`은 앱
종료/실제 profile lock 아래 `a-before-startup-cleanup.sock`으로 보존한 뒤 새
패키지로 같은 실패를 다시 만들었다. 새 실패에서는 server가 code 1로 정리되고
`a.sock`이 사라졌으며 링크 두 개는 남았다. 포트를 해제하고 URL 없이 새로
실행하자 `fixed-resumed-stderr.log`의 delivered 2 및 빈 pending record,
`fixed-resumed-ax.txt`/`.png`의 정상 root 화면을 확인했다. fixture socket/로그는
보존한다. 생산 앱/데이터/키/공개 release는 변경하지 않았다.

남은 목표는 동일 소스 signed/notarized A→B와 폭넓은 데이터/취소·복구 검증,
production owner/OS13/키 custody·backup 조건, updater 활성화 및 최초/후속 공개
배포다. 이 결과로 모든 SDK 확장이나 OS 이탈 descendant를 증명하지 않는다.

## 2026-09-08 현재: 실제 버튼 A10 → B3 교체·재시작·첨부 보존 통과

격리된 QA 앱에서 About의 `Update and restart`로 A10(product beta.10 / desktop
0.2.4) → B3(beta.11 / 0.2.5)가 실제 교체되고 자동 실행됐다. 자동 확인 설정은
false인 상태로 유지됐다. `A10-stderr.log`는 Applying → backend prepare/commit →
서버/포착한 하위 process 종료 → manual intent → 다음 시작의 installer 호출/전체
트리 검증 → 신버전 자동 재실행 → `successor-health-committed`를 기록한다.
`A10-manual-cycle.jsonl`과 schema-2 완료 marker는 이전 native/server/core 종료 및
후속 native 7560/server 7766을 확인한다. 실제 설치된 Info.plist는 0.2.5이며
`codesign --verify --deep --strict`도 통과했다.

`B3-after-update-ax.txt`/`.png`: beta.11 UI, Scratch 프로젝트, 동일 origin
`http://127.0.0.1:50761/`, 미전송 초안과 SVG 미리보기 유지.
`B3-after-update-bytes-ax.txt`: 실제 IndexedDB schema 2 / revision 51 / 초안 일치 /
첨부 1개 / queue 0. 172-byte SVG SHA-256은 원본과 동일하다:
`f744bd2e0ac70466bcd76177a22fb54cdbe87bf55b4540d5f7837d64d65c994e`.
증거 root는 아래와 같은 `/private/tmp/gajae-native-restart.wupMI0/`다.

이는 **debug/ad-hoc 앱 + 전용 QA updater 서명**의 incremental 실증이다.
B3는 A10의 마지막 native 순서 변경 이전 빌드이므로 최종 same-source signed/
notarized acceptance가 아니며, 공개 배포나 production 활성화도 하지 않았다.
정상 Quit 후 `--qa-profile`만으로 재실행한 B3도 beta.11, 같은 origin/프로젝트,
초안/미리보기를 유지했다(`B3-normal-reopen-ax.txt`, `.png`). 검증 후 QA 앱과
임시 관측/피드는 정리하며 fixture/로그는 보존한다. 로그인/실제 transcript/대기열의
폭넓은 데이터 보존, 전체 production 게이트와 공개 릴리즈는 남는다.
자동업데이트와 배포 목표는 유지한다.

## 이전 실패·수정 과정: native restart 거래 연결과 GUI QA

부모 인계 기준 pushed HEAD는 `721806d`이며, 그 위 native restart 거래는
**약 35개 파일의 미커밋 WIP**다(동시 작업으로 파일 수는 변할 수 있다).
아래는 source/저장된 로그 checkpoint이지 배포 또는 수동 재시작 성공 기록이 아니다.
자동 업데이트 완성과 공개 배포라는 전체 목표를 유지한다.

- [native restart](../src-tauri/src/updater_restart.rs)는 native challenge →
  현재 페이지의 draft 저장·seal ACK → Applying 표시/페이지 종료 → backend prepare →
  owner 재검증/commit → owned server/tree 종료 확인 → 대상 archive에 결합된 durable manual
  intent → 재시작을 연결한다. 실행은 **compile-bound QA 앱 + 정확한 QA profile만**
  허용한다. 불명확한 commit/종료는 recovery이며 자동 재시도하지 않는다.
- [native backend](../src-tauri/src/updater_backend.rs),
  [Node channel](../server/services/desktop-restart-channel.ts),
  [backend owner](../server/services/desktop-restart-backend.ts)는 인증된 별도
  native 채널의 epoch/순번/attempt/token을 결합한다. browser prepare/commit
  endpoint는 없다. `ui-drafts` reader도 연결됐지만 실제 seal이 없으면 blocker다.
- [owner 관측](../src-tauri/src/updater_owners.rs)은 정확한 QA root의 packaged
  owner만 격리하고 production은 기존 cross-installation 범위를 유지한다.
  전체 PID 열거와 포착한 descendant tree의 종료 검사는 축소하지 않는다.
  두 번의 bounded census는 atomic process history나 이미 이탈한 daemon의
  종료 증명이 아니다. 이 source를 production owner qualification으로 세지 않는다.
- [native payload](../src-tauri/src/expected_payload.rs)와
  [archive 검사](../src-tauri/src/updater_archive.rs)가 runtime manifest schema 2의
  같은 strict parser를 사용하도록 SSOT 불일치를 수정했다. archive는 native
  closure와 SDK lifecycle post-hash의 실제 regular-file 멤버도 검사한다.
  `VerifiedSdkPatch`는 source 무결성만 증명하며 full SDK quiescence가 아니다.

증거 root: `/private/tmp/gajae-native-restart.wupMI0/`. 부모 실행 결과:

- `verify-final.log`: 전체 `npm run verify` exit 0.
- `native-tests-final-rerun2.log`: desktop Rust **307 pass / 5 ignored**, 별도
  build-binding **10 pass**. ignored는 통과로 세지 않는다.
- `native-clippy-final.log`: 통과. 이후의 소규모 QA 진단/테스트 fixture 변경
  이전 결과이며 최종 작업 트리 전체의 재검증으로 확장하지 않는다.

첨부가 있는 실제 GUI A4–A7은 File/Blob `NotFoundError`로 **backend prepare 이전**에 실패했다.
각 `A4-stderr.log`–`A7-stderr.log`는 `draft-challenge`까지만 기록한다.
**이 수동 재시작 거래의 실제 성공은 아직 없다.** 이전
[next-launch A→B](DESKTOP-UPDATER-LAUNCH-QA.md)는 다른 경로의 격리 QA 증거다.

원인 분리 증거는 `webkit-picker-reopen-ax.txt`와 `webkit-picker-reopen.png`다.
격리 DB에 picker File·메모리 생성 File·ArrayBuffer를 저장하고 같은 QA 앱을
정상 종료/재실행했다. 첫 조회는 셋 모두 172 bytes였다. 조회한 record를
`durability: 'strict'` transaction으로 다시 쓴 뒤, 보유 중인 객체와 새 조회
객체 **양쪽의 두 File 모두 `NotFoundError`**, ArrayBuffer는 계속 172 bytes였다.
따라서 이 재현은 앱 교체 없이도 발생하는 record 재저장/Blob 수명 문제이며,
단순 재실행만으로 File이 사라진다거나 backend prepare가 실패했다는 증거가 아니다.

후속 text-only 시험: 부모는 실제 profile lease를 잡고 격리 home/browser를
같은 증거 root의 `A7-profile-before-codec/`에 백업한 뒤 **현재 QA 초안의 fixture
첨부만** 제거했다. 원본 fixture와 백업은 보존했다. `A7-reopen-stderr.log`는
아래 재시작 경로를 기록한다. 주의: `home/browser` 백업에는 UUID로 격리된
WKWebsiteDataStore가 포함되지 않는다. 그 디렉터리 복원만으로 IndexedDB 초안이나
첨부가 복원됐다고 해석하지 않는다. 이전 형식 실증은 구버전 앱으로 다시 만든다.

`A7-reopen-stderr.log`:
`backend-prepare → backend-prepared → applying-visible → updater_restart_cancelled`
를 기록한다. 첨부 없는 경로도 commit/재시작 성공은 아니다.
예정된 Applying navigation의 fetch 거부 뒤 JS가 자동 cancel을 보내는 self-cancel
race가 유력 원인이다. 부모의 [bridge 수정](../src-tauri/src/updater_bridge.js)과
[회귀 테스트](../src/shared/nativeUpdateBridge.dom.bun.test.tsx)는 prepared ACK를
보낸 뒤 응답이 유실돼도 자동 cancel을 보내지 않고 native abort 확인까지 seal을
유지한다(native가 deadline 소유). 빌드/검증 진행 중이며 실제 성공은 미확인이다.

[versioned byte-backed codec](../src/components/chat/utils/composerDraftStorage.ts)은
File 대신 실제 bytes와 metadata를 저장하고 조회 시 독립 File을 만든다. 읽을 수
있는 legacy File은 이후 CAS 저장 전에 복사한다. 읽기 실패는 원본을 덮어쓰거나
saved로 표시하지 않는다. 부모의 `codec-parent-tests.log`는 실제 repository를
구동하는 합성 IDB driver와 인접 DOM/bridge 5개 suite에서 **123 pass**다.
WebKit 실증과는 구분한다. **위 verify 통과 로그는 codec/후속 bridge 변경 이전이다.**
`native-clippy-qa-fixes.log`와 `native-tests-qa-fixes.log`는 후속 native 진단과
fixture 수정까지 통과했다(307 + 10 pass, 5 ignored).

A8 text-only 실제 버튼 시험은 `backend-prepared` 뒤 owner capture 또는 Applying
뒤 owner revalidation에서 보류됐다(`A8-stderr.log`, `A8-manual-cycle.jsonl`).
JS self-cancel 수정 후에도 commit/종료/교체 성공은 아직 입증되지 않았다.
다음 빌드에는 native owner scanner의 정적 사유를 QA-only 로그에 남긴다.
부모가 동일 소스 A/B payload 빌드, 합집합 검증과 실제 재시작·첨부 byte 보존을
이어서 확인한다. 임시 QA 버전 변경은 배포 버전 변경이 아니며 빌드 후 복구한다.

추가 실증: 구버전 A8 GUI에서 fixture를 다시 첨부·저장하고 정상 종료한 뒤 A9를
실행했다. A9의 restart 준비는 첨부 byte 검증과 owner revalidation을 통과했지만
Applying 후 backend commit의 `updater_runtime_changed`로 취소됐다.
`A9-migrated-draft-ax.txt`는 그 뒤의 실제 IndexedDB read-only 조회다:
schema 2, revision 50, 초안 일치, 첨부 1개(172 bytes), queue 0;
SHA-256 `f744bd2e0ac70466bcd76177a22fb54cdbe87bf55b4540d5f7837d64d65c994e`가
원본 fixture와 일치한다. 미리보기도 유지됐다. 이것은 실제 legacy 마이그레이션
증거지만 자동 앱 교체 성공 증거는 아니다.

`verify-codec-union.log`는 codec/bridge 합집합의 전체 verify exit 0이다.
후속 A10은 sealed 페이지를 Applying으로 전환한 뒤 backend prepare를 요청한다.
예정된 WebSocket/HTTP 종료를 generation 검사의 예외로 인정하지 않고, 페이지
종료 뒤 새 runtime 증명을 얻는다. 바쁘거나 불명확하면 여전히 취소하며 설치와
server 종료는 commit 이후다. 원래 5초 준비 예산도 유지한다.
`native-clippy-handoff-order.log`와 `native-tests-handoff-order.log`는 통과했다
(307 + 10 pass, 5 ignored). A10 → B3는 이 순서 수정 전후 native가 다른
incremental QA 쌍이므로 최종 same-source signed qualification으로 세지 않는다.
production 활성화/owner qualification, key custody와 backup, signed/notarized
same-source A→B, 실제 macOS 13, G0 승인·취소 및 privileged writer 종료 증명,
deep-link buffering, 미표현 SDK streaming/extension tails와 전체 G3/G5,
최초/후속 공개 배포는 남아 있다. `/Applications`의 production 앱은 사용 중이며
이 문서 sidecar는 앱·사용자 데이터·키를 조회하거나 변경하지 않았다.

## 이전 checkpoint: 2026-09-08 SDK 패치 적용·source 검증·페이지 owner 등록

최신 커밋 `06bbc51`은 Linux 패키지 데이터 보존 검증에서 확인된 종료 순서
문제를 수정한다. watcher 정리를 기다리기 전에 native job interruption을
기록한다. 일반 CI, Linux 서버 아카이브와 Linux desktop CI가 모두 통과했다.

이후 작업 트리에는 **아직 커밋하지 않은** 다음 통합이 있다.

- `patches/gjc-sdk-lifecycle/manifest.json`의 8개 파일을 모두 pristine hash와
  비교한 뒤 적용했다. SDK/core/AI 버전은 0.16.4 그대로다. prewarm, physical
  prompt/loop/post-prompt, registry 유지보수, auth timeout loser와 설정 저장을
  실제 Promise 정리까지 추적한다. 생성자/global owner도 adapter에서 관측한다.
- root와 desktop/server staging의 postinstall이 같은 패치를 적용한다.
  `check:sdk-patch`, runtime manifest schema 2의 전체 post-hash와 의존성
  해석 경로 검사가 불완전/다른 SDK를 거부한다. applier의 symlink CLI 경로가
  검사를 건너뛰던 문제도 회귀 테스트와 함께 수정했다.
- `VerifiedSdkPatch`는 source 무결성만 증명한다. SDK streaming producer나
  확장 callback의 아직 표현되지 않은 tail은 `sdk_background_ownership_unproven`
  으로 남는다. 이를 없애거나 full G3를 통과했다고 선언하지 않는다.
- App 최상위의 draft owner가 native가 주입한 브리지에 실제 등록된다.
  토큰·준비 객체·현재 창 수명이 결합되며 오래된 등록/응답은 거부한다.
  등록은 저장 ACK나 재시작이 아니다. native challenge → draft ACK → backend
  prepare/commit → 안전 종료 거래와 production previous-owner 증명은 남아 있다.

증거: `/private/tmp/gajae-sdk-integration.v1k0FL/`. 설치된 패치의 lifecycle
24개와 replay/applier 4개, SDK 계약 101개(선택적 live 1개 제외), manifest/
SSOT 테스트, 브리지 DOM 합집합 62개와 native bridge Rust 10개가 통과했다.
`verify-sdk-union.log`도 통과했으며 이후 추가한 nested SDK 해석 검사는 별도
테스트로 확인했다. 실제 macOS payload도 새로 빌드하여 pristine npm 설치에서
8개 패치 적용, out-of-tree 재검증, 실제 Bun worker initialize/shutdown 및
서버 health/종료 smoke를 통과했다(`macos-payload.log`). 이는 ad-hoc native
payload 검사이며 signed/notarized 앱 교체나 GUI acceptance가 아니다.
최종 `verify-promotion.log`도 통과했으며 코드/테스트/문서 및 적용 SDK 파일을
포함한 38개 입력 해시가 검증 전후 동일했다. 이후 이 결과 문단만 갱신했다.
GJC E2E 8개, browser E2E 3개와 desktop Rust 267개 + binding 10개도 통과했다
(`gjc-e2e.log`, `browser-e2e.log`, `native-full.log`). 배포 전 native 거래/
owner 증명과 최종 서명 앱 수용 검증은 여전히 남는다. 현재 설치 앱,
production key, 공개 release는 바꾸지 않았다.

## 이전 checkpoint

## 2026-09-08: 작업 소유권·페이지 초안 동결·worker fence 통합

이 절은 `c64d8aa` 이후 소유권 통합 작업의 진행 기록이다.
자동업데이트는 배포 목표에 포함된다. 수동 설치 검증과 구버전 → 신버전 자동
교체 검증의 차이는 목표를 분리하거나 완료 범위를 줄인다는 뜻이 아니다.

- `server/index.js`는 필수 15개 owner 중 14개 reader를 연결하고, startup
  catch-up 이전에 같은 admission을 worktree/orchestrator/native clients,
  worker/automation/browser/computer/watcher/notification에 주입한다.
  Git/clone 및 server startup/listen callback을 `internal-producers`에
  연결했다. native-bound `ui-drafts`는 아직 누락 blocker다.
- native `job.activity`는 archived job과 미완료 run을 포함하는 읽기 전용
  aggregate다. 관측은 프로세스를 새로 시작하거나 reconcile하지 않는다.
- project 파일 스트림과 업로드는 실제 descriptor/pipeline/cleanup 완료까지
  HTTP 소유권을 유지한다. watcher의 잘못된 조기 close를 실제 종료 경로로
  옮겼으며 kill/abort 요청만으로 종료를 확인했다고 처리하지 않는다.
- worker activity/admission 프로토콜, 브라우저 child queue/popup/close 증명,
  알림 전송 callback과 페이지 초안·첨부·녹음 freeze를 구현했다.
  페이지 receipt는 `scope: page`, `installerAuthority: false`이며 아직
  native restart 허가가 아니다.
- 공통 ingress fence가 먼저 닫힌 뒤 worker fence를 닫고 관측한다. setup과
  read는 원래의 5초 예산을 공유하며, 취소/timeout/expiry는 늦은 close와
  정확한 ID의 release 완료까지 소유권을 유지한다. commit 뒤에는 열지 않는다.
  원격 SDK generation 변화도 기존 준비를 무효화한다.
- SDK 0.16.4에서 공개 dispose join 뒤에도 prewarm credential 작업이 남는
  반례를 재현했다. `sdk_background_ownership_unproven`을 유지한다.
  공식 배포 0.16.6의 해당 코드도 동일함을 별도 임시 경로에서 확인했다.
  앱 전용 SDK 패치를 준비 중이며 dependency pin이나 node_modules는 아직
  변경하지 않았다. `scripts/apply-sdk-lifecycle-patch.mjs`는 정확한 버전과
  수정 전후 해시 검증·일치하는 변경의 1회 적용·멱등 재검증 도구이며 아직
  postinstall/배포 경로에 연결하지 않았다. 실제 SDK patch가 검증되기 전
  `sdk_background_ownership_unproven`을 없애지 않는다.

증거 경로: `/private/tmp/gajae-updater-ownership.6r2PfB/`.
부모의 HTTP/file-transfer 8개, native client/watcher/runtime/route-coverage
31개, authority 경합 106개, SDK patch 도구 7개 테스트와 `check:core`가
통과했다. 전체 `verify-union.log`도 통과했으나 최종 추가 통합 뒤의 promotion
검증과는 구분한다. `verify-working.log`의 TS2322는 수정된 이전 실패 기록이다.
최종 `verify-promotion.log`도 통과했고 검증 전후 78개 소스/테스트/문서 입력의
SHA256이 동일했다. 이후 이 검증 결과 문단만 갱신했다. worker의 실제
supervisor/host/protocol을 사용한 통합 경합을 포함해 worker-client 77개가
통과했다(`worker-integrated.log`). desktop shell fmt/locked test도 통과했다
(`native-shell.log`). Apple 서명 identity와 기존 notary profile의 read-only
인증 확인도 통과했지만 서명키 생성·반출·공증 제출·공개 배포는 하지 않았다.
GJC wire/browser E2E 8개와 browser E2E 3개가 통과했다. wire fixture는 종료된
orchestrator를 재사용하지 않고 새 HTTP/projection/orchestrator로 재개하도록
수정했다. 첫 실패 로그도 보존하며, 이 결과는 설치 앱 handoff 검증이 아니다.
제품 버전과 production updater 활성화/공개 배포는 변경하지 않았다.

## 2026-09-08: 다음 시작 설치·후속 앱 건강 확인 연결

`DESKTOP-UPDATER-LAUNCH-QA.md`가 최신 네이티브 진행 기록이다. 격리된 debug QA에서
A(0.2.4) → B(0.2.5)의 실제 교체·자동 재실행·서버 건강 확인·schema-2 완료 기록과
프로젝트/초안/첨부/동일 origin 보존을 확인했다. **임시 서명 QA이며 공개 배포가
아니다.** 실행은 정확한 compile-bound QA profile과 명시적 qualification 인자로만
허용하며 production owner 증명/활성화, 전체 G3와 최종 G0/G5/배포는 남아 있다.

## 활성 목표: 자동 업데이트 완성과 앱 배포

목표는 준비 경로 구현으로 축소하지 않는다. 현재 이어지는 네이티브 설치 작업과
검증 근거, 다음 시작/건강 상태/복구 연결의 순서는
`DESKTOP-UPDATER-INSTALL-PROGRESS.md`에 있다. 공식 installer 호출, durable
attempt writer, 전체 설치 트리 검증과 **격리된 QA 시작·재시작 경로를 연결했다.**
일반 배포용 활성화와 native-bound 안전 재시작은 아직 남아 있다.
원격 CI에서 드러난 엔진 테스트 SSOT 누락은
`7ef7cda`로 수정했다. 자동 설치/배포 완료를 선언하거나 목표를 닫지 않았다.

## 2026-09-08 재개: 실제 admission 연결과 초안 보존

`server/index.js`에 하나의 restart authority를 만들고 HTTP handler, 채팅 메시지,
PTY 메시지와 인증 전 경로에 연결했다. 응답/연결 종료와 실제 작업 종료를 구분하고,
준비 중 완료된 작업도 이전 prepare token을 무효화한다. chat/worker/shell의 실제
reader를 합치되 나머지 필수 owner는 누락 상태로 남겨 재시작을 차단한다.

OAuth 취소 후 정리, UI 완료 이후 제목 저장, 교체 중인 PTY를 실제 수명까지
추적한다. SDK 내부 백그라운드와 detached descendant 종료는 미확인이므로
유휴 상태라고 주장하지 않는다. 실제 composer에는 IndexedDB 기반의 초안·File·
대기 메시지 보존과 오래된 창의 덮어쓰기 방지를 연결했다.

구현/증거/남은 작업: `DESKTOP-UPDATE-ADMISSION-IMPLEMENTATION.md`.
**자동 설치·안전 재시작·공개 배포는 여전히 미완료다.** G0를 완화하거나 제품
installer를 켜지 않았으며 package/desktop 버전은 beta.10/0.2.4 그대로다.

## 사용자 환경 확인 후 실제 QA 앱 검증

사용자는 이전 인증창에서 무엇을 눌렀는지 기억하지 못하며 macOS 13 테스트
환경도 없는 것 같다고 답했다. 취소 성공과 OS13 검증은 **미확인 그대로**다.
추가 환경 준비를 사용자에게 요구하지 않고 현재 Mac의 격리 QA 증거를 보강했다.

- ES2020 `Object.hasOwn` 타입 오류를 수정해 원격 Node 22/24 CI를 통과시켰다
  (`6f99642`, run `34140074184`). 이전 로컬 검사 후의 마지막 편집이 CI에서 실패한
  것이며, 이전 head의 원격 CI까지 통과했다고 해석하지 않는다.
- 실제 debug/QA 앱의 기동을 막던 긴 automation socket 경로를 짧은 private
  `a.sock`으로 수정했다. 길이 한도는 플랫폼 구조체에서 얻고 실제 bind로 검증한다.
- 실제 About의 503 오류를 재현했다. accepted socket의 nonblocking 모드 때문에
  HMAC 응답 다음 read가 너무 일찍 실패했다. 인증/peer PID/시간·크기 한도는
  유지하면서 연결 읽기 모드를 수정했고 실제 Node↔Rust 회귀 테스트를 추가했다.
- 실제 QA 앱에서 native 상태, 설정의 durable 저장, 자동 확인 off 상태의 수동
  확인, 잘못된 피드 오류 및 복구, 정상 종료와 같은 origin 재실행/설정 보존을
  확인했다. auto-off 재기동의 잔존 `server_not_ready` 문구도 수정했다.
- 설치 시도 journal은 **examples 아래 QA-only 증명 도구**다. fsync 전 live
  handle 부재, 실패/Drop/crash 뒤 차단 기록 보존 등을 20개 테스트로 검사했다.
  실제 installer/writer 종료, 적대적 same-UID namespace, 전원 차단 또는 제품
  설치 resolver 검증이 아니다. 기존 생산 startup guard는 그대로 보수적으로 차단한다.

전체 근거와 재개 방법: `DESKTOP-UPDATER-QA-PREPARATION.md`.
생산 `/Applications` 앱, 실제 사용자 데이터, public release와 updater key는
변경하지 않았다. **자동 설치·재시작·공개 배포는 아직 완료되지 않았다.**

## 추가 구현: 메인 화면 준비 제어와 restart admission 기초

브랜치 `codex/macos-updater-completion`의 미배포 변경이다. **전체 자동
업데이트 완료가 아니며 설치·재시작은 계속 거부한다.** 아래 내용은 이어지는
이전 진행 기록의 ‘준비 경로 UI/bridge 없음’ 부분을 갱신한다.

- `shared/desktopUpdateProtocol.ts` + 공용 상태 fixture를 기준으로 native
  snapshot, 준비 상태/설정/수동 확인 명령과 About UI를 연결했다. 웹 알림은
  별도 SemVer/channel 기준이며 desktop에서는 native snapshot만 사용한다.
- native가 만든 일회성 stdin 초기화로만 Node relay에 연결 정보가 전달된다.
  비밀값은 환경변수/로그/브라우저 응답에 넣지 않는다. 혼합 stdout은 제어
  입력으로 사용하지 않고 소유자 전용 Unix socket을 사용한다.
- 연결마다 새로운 challenge/HMAC-SHA256 증명으로 native endpoint를 먼저
  인증한 뒤에만 view capability를 전송한다. macOS `LOCAL_PEERPID`가 실제
  소유 Node PID와 일치해야 하므로 socket을 바꿔 끼운 다른 프로세스가 진짜
  native에 challenge를 대신 전달할 수 없다. HMAC은 macOS 대상의 정확히
  고정한 `hmac=0.12.1`이며 기존 tempfile/getrandom 선택은 유지했다.
- HTTP는 desktop cookie + 정확한 Origin + 현재 main-view capability를 요구한다.
  페이지/서버 교체 시 권한을 폐기하고, preference 직렬화 잠금 안에서 다시
  권한과 mutation sequence를 확인한다. 오래된 요청이 새 opt-out을 덮지 않는다.
  4개 요청, 2초 relay deadline, 제한된 frame 크기이며 timeout은 취소/저장 성공이 아니다.
- QA 환경의 `env_clear()` 뒤에 relay flag를 설정한다. disabled/dev/Linux에서는
  제어 채널을 시작하지 않으며, native bridge 초기화 실패 시 자동 준비도 시작하지 않는다.
- About에 EN/KO 및 10-locale parity, null progress, 상태/오류/릴리즈 노트,
  실제 저장 응답 뒤에 반영하는 자동 설정과 수동 확인을 추가했다. 준비 완료를
  설치 완료로 표시하지 않는다. ordinary web에는 설치 제어가 없다.
- `DesktopRestartAuthority`는 하나의 가역 fence와 기존 owner snapshot을 합칠
  안전 기초다. 95개 테스트를 통과했지만 **실제 HTTP/WS/internal producer와
  아직 연결하지 않았으므로 G3 통과가 아니다.** 필요한 연결 지점은
  `DESKTOP-UPDATE-ADMISSION.md`에 있다. native `restart`도 명시적으로 거부한다.
- 검증: 통합 `npm run verify`, native locked tests 179 pass + 1 opt-in ignore,
  build-binding 10 pass, native clippy `-D warnings`, relay/HTTP/admission 141 tests,
  frontend DOM 33 tests를 부모가 실행해 통과했다. Browser 스킬의 격리 UI fixture로
  1024×768/390×844, 한국어/영어, 설정 반영과 미정 progress를 확인했다.
  이는 native packaged-app/설치 GUI 증거가 아니다.

격리된 About 상태 fixture의 화면(설치 실행 없음):

![자동 설치는 차단된 준비 상태 UI](images/updater/about-preparation-qa.png)

### 실제 installer probe 결과 정정

- 첫 authorization probe는 취소가 아니라 `install()` 성공으로 반환했다.
  별도 `authorization-approved-verification.json`에서 전체 B inventory,
  코드 서명·staple·Gatekeeper를 검증했다. 취소 성공으로 기록하지 않는다.
- 두 번째 probe(시작 `2026-09-07T14:52:06Z`, root suffix `F5tbr5`)는
  `install_failed`, exit 1/signal 없음으로 반환했다. 전체 A inventory 및
  서명·staple·Gatekeeper는 그대로였다. 사용자에게 실제 ‘취소’ 클릭 여부를
  확인 요청했으며 `humanActionConfirmed`는 아직 false다. 원인 구분 및 OS
  privileged writer 종료 증거를 단순한 PID 종료/오류 문자열로 대체하지 않는다.
- 로그/receipt/runner는 `/private/tmp/gajae-updater-resume.Ym5u1L/`에 유지했다.
  기존 승인 결과는 `authorization-approval-result.json`에 따로 보존했다.
  최신 `authorization-result.json`을 이전 승인 결과로 혼동하지 않는다.

### 그대로 남은 차단 조건

G0 취소·writer 종료/설치 오류 분류, 실제 macOS 13 검증, 전체 producer와
draft/첨부 보존의 G3 연결, install-attempt writer/resolver/다음 시작 적용,
safe restart와 embedded applying/recovery, 최종 서명된 제품 QA A→B 및 데이터
보존, production updater key custody/backup와 배포가 남아 있다. 이 Mac은
26.6.2이고 등록된 repository self-hosted runner는 0개이며 로컬 macOS 13 VM은
확인하지 못했다. 지원 하한이나 권한 검사를 낮추지 않았다. Package/desktop
버전은 beta.10/0.2.4 그대로이고 새 릴리즈·설치·production key 생성은 하지 않았다.

## 2026-09-07 추가 재개: 설치 기능 완성 요청

사용자가 재배포를 통한 업데이트 시험을 요청했고, 기존 beta.10의 updater가
disabled이고 웹 알림의 `/releases/latest`도 베타 전용 저장소에서 404인 사실을
설명한 뒤 **자동 업데이트 완성부터 진행**하도록 승인했다. 현재 브랜치는
`codex/macos-updater-completion`이며 아래 결과는 전체 기능 완료/배포가 아니다.

- 웹 알림 fallback을 releases 목록 + 표준 SemVer/channel 비교로 수정했다.
  14개 단위 테스트와 8개 DOM 테스트를 부모가 재실행해 통과했다. native 설치
  권한이나 UI는 추가하지 않았다. 전체 verify는 별도로 실행 중이다.
- `docs/DESKTOP-UPDATE-ADMISSION.md`에 실제 producer/owner와 zero-gap accounting
  미검증 지점을 정리했다. 이는 구현지도이며 G3 통과가 아니다.
- 현재 locked 공식 updater 2.6.0 probe를 다시 빌드했다. 새 private-CA HTTPS
  격리 fixture에서 역사적 signed beta.8→beta.9의 실제 `install()`이 반환했고,
  전체 B inventory, codesign, staple, Gatekeeper를 다시 확인했다. 기존 앱은
  실행하지 않았으며 `/Applications` 또는 실제 사용자 데이터는 수정하지 않았다.
  역사적 11.0 선언/13.0 loader 불일치는 그대로이므로 이 결과는 설치 primitive
  증거일 뿐 새 제품 릴리즈, macOS 13 또는 최종 signed QA A→B acceptance가 아니다.
- 취소 probe는 사용자 응답 대기 중이다. 임시 증거/runner:
  `/private/tmp/gajae-updater-resume.Ym5u1L/`. `authorization-running.json`이
  정확한 현재 root, driver, PID를 기록한다. 시작 시 PID는 11927이었다.
  스택 표본은 공식 `install_inner` → OSAKit `Script::execute`에서 대기함을 보였고,
  Computer Use의 테스트 앱 AX 읽기는 두 차례 timeout이었다. 창이나 실제 취소를
  관찰한 것으로 취급하지 않는다. 사용자에게 표시된 시스템 인증창을 취소하고
  알려 달라고 요청했다. 강제 종료/timeout 후 성공 처리하지 않는다.
- `replace-result.json`은 정상 교체 증거, `authorization-result.json`은 probe가
  반환한 뒤 생성된다. 재개 시 먼저 결과/프로세스를 확인하고 사용자의 실제
  동작과 전체 A 무결성·writer 종료를 별도로 입증한다. PID 숫자만 재사용하여
  신호를 보내거나, 결과 파일만으로 사용자 취소를 확인했다고 기록하지 않는다.
- 설치 수명주기/attempt writer·resolver, 좁은 native bridge, 전체 admission,
  About UI, OS13 실행, production key custody, 최종 QA/배포는 아직 남아 있다.
  G0/G3 조건을 완화하거나 production updater를 켜지 않았다.

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
