# gjc provider — 구현 기록 (Gajae Code App, 2026-07-16)

Gajae Code App의 provider `gjc`(Gajae Code) 구현 기록. 초기 read-only 세션 목록/열람 경계는 codex JSONL 스캐너를 참조했고, 현재 live 실행은 전용 worker와 Rust core를 통과한다. 업스트림 PR 금지 — Gajae Code App에서 개발.

## 세션 스토어 (실측)
- 위치: `$HOME/.gjc/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl`
  - `<cwd-slug>` = 절대 cwd에서 `$HOME` 스트립 후 `/`→`-`. 예 `/workspace/gajae-app` → `-workspace-gajae-app`. (표시용; **권위 있는 cwd는 JSONL 헤더**.)
  - 세션당 동명 사이드카 디렉터리(`<...>_<uuid>/`)에 artifacts/resident-cache. **인덱싱은 `.jsonl` 파일만**(사이드카 하위 blob은 확장자 없어 자동 제외).
  - 서브에이전트 세션 = 같은 디렉터리의 형제 `.jsonl`.
- **JSONL 라인 스키마** (한 줄=한 이벤트, `id`/`parentId` 트리):
  - 헤더(1행): `{"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"<절대경로>"}` — codex의 `payload.id/payload.cwd`와 달리 **최상위 `id`/`cwd` 직접**.
  - 메시지: `{"type":"message","id":..,"parentId":..,"timestamp":..,"message":{"role":"user|assistant|toolResult","content":[...]}}`
    - `content[]` 파트: `{type:"text",text}`, `{type:"thinking",..}`, `{type:"toolCall",..}`, `{type:"toolResult",..}` (usage/cost/model 메타 동반 가능).
  - 명시적 스킬 요청: `type:"custom_message", customType:"skill-prompt", display:true, attribution:"user"`는 검증된 `details.name`과 선택적 문자열 `details.args`로 `/skill:<name> <args>`를 복원한다. 확장된 `content`와 스킬 경로는 표시하지 않는다. 히스토리·턴 계보·제목 파생에 동일하게 적용하며, 숨김·비사용자·잘못된 메타데이터는 제외한다.
  - 기타 이벤트: `model_change`, `thinking_level_change`, `custom` 및 그 외 `custom_message` — 대화 표시엔 무시하되 `parentId` 계보는 유지한다.
  - **title 전용 필드 없음** → 첫 user 메시지 또는 위 스킬 요청에서 파생(claude/codex 방식). 보조로 `~/.gjc/agent/history.db`(`history(prompt,cwd,created_at)`) 최근 prompt.
- agent.db/history.db/models.db는 세션 아님(auth/cache/usage/settings, 프롬프트 입력이력, 모델카탈로그). **읽기 전용만**(WAL, 라이브 프로세스 사용중).

## 파일 (codex 원형 복제 → gjc 맞춤)
`server/modules/providers/list/gjc/`:
- `gjc.provider.ts` — wrapper. `AbstractProvider` 확장, `super('gjc')`, facet: models/mcp/auth/skills/sessions/sessionSynchronizer.
- `gjc-session-synchronizer.provider.ts` — 원형 `codex-session-synchronizer`. `gjcHome=~/.gjc/agent`, 스캔 `path.join(gjcHome,'sessions')`. `extractFirstValidJsonlData`로 첫 줄 파싱: **`data.id`/`data.cwd` 직접**(codex처럼 payload 아님). title=첫 user message 파생(`extractFirstUserMessageFromStart`를 gjc `type:message,role:user` content-text로 재작성) → 없으면 history.db → 없으면 `Untitled gjc Session`. 파생은 `shared/utils.ts`의 `deriveSessionTitle`(슬래시 커맨드·@멘션·코드 펜스·마크다운 제거, 첫 문장 경계, ≤40자 + `…`)을 거치며, DB에 이미 이름이 있으면 덮어쓰지 않는다. `deriveSessionTitle(filePath)`는 `POST /api/providers/sessions/:id/regenerate-title`이 사용자 요청으로 제목을 다시 파생할 때만 기존 이름을 대체한다. `sessionsDb.createSession(id, 'gjc', cwd, name, createdAt, updatedAt, filePath)`. **모델 제목**: 새 세션의 첫 턴에서 Bun 어댑터가 런타임의 `utils/title-generator`(`generateSessionTitle`, TUI와 동일 조건: 첫 user 메시지·이름 없음·`GJC_NO_TITLE` 미설정)를 호출해 `sessionManager.setSessionName(title,'auto')`로 트랜스크립트 헤더에 기록하고, `{kind:'session_title'}` 메시지를 보낸다. `ChatSessionWriter`가 이를 채팅으로 내보내지 않고 `sessionsDb.applyGeneratedSessionName`으로 저장한 뒤 `session_upserted`로 방송한다. 우선순위는 `sessions.name_source`(`user` | `auto` | `derived` | NULL=구버전 행)로 정한다: 사용자가 지은 이름은 사용자만 바꾸고, 모델 제목은 그 외 전부를 대체하며, 파생 제목은 동기화기가 값을 바꿀 때 찍힌다.
- `server/modules/providers/services/gjc-session-watcher.service.ts` — `gajae-core watch`를 별도 자식 프로세스로 실행해 저장 세션 루트와 live 세션 루트 안에 canonical containment를 통과한 `.jsonl` add/change 이벤트만 64 KiB 제한 NDJSON으로 수신한다. 이벤트는 순서대로 기존 `synchronizeProviderFile('gjc', path)`에 전달하며, 큐 상한·ready 타임아웃·취소 가능한 종료 drain·지수 백오프 재시작·재시작 후 GJC 전용 reconciliation을 적용한다. GJC용 Chokidar fallback은 없고 기존 4개 provider watcher는 그대로 유지한다.
- `gjc-transcript-message.ts` — 일반 메시지와 표시 가능한 사용자 스킬 요청을 공통 해석한다. 히스토리·턴 계보·제목 파생이 공유하며, 스킬의 확장 본문은 반환하지 않는다.
- `gjc-sessions.provider.ts` — `getSessionById(id).jsonl_path` → 제한된 JSONL 스트리밍 → 공통 메시지 해석 → `message.role` + `message.content[]` 파트별 user/assistant/thinking/tool_use/tool_result 정규화. timestamp 정렬 후 표시 행(tool_result 제외) 기준 tail 페이지네이션: 작은 인덱스 pass 뒤 선택된 행과 그 tool_result만 두 번째 pass에서 payload로 유지하고, 읽는 동안 파일이 바뀌면 재시도 후 409(`HISTORY_CHANGED`), 무제한 요청은 표시 행 5,000개까지만 허용하고 초과 시 413(`HISTORY_PAGE_TOO_LARGE`) (`createNormalizedMessage`/`generateMessageId`, 멀티 text 파트 id 충돌 방지 discriminator).
- `gjc-auth.provider.ts` — `command -v gjc` + 로그인 상태(agent.db:auth_credentials 존재 or `gjc` CLI). 미설치/미인증은 데이터로 반환(예외 아님).
- `gjc-skills.provider.ts` — `SkillsProvider` 확장. 루트: user `~/.gjc/agent/skills`, project `<ws>/.gjc/skills`. prefix: 스킬은 트리거 자동활성(명령형 아님) — codex `$`/claude `/` 참고해 gjc 표기 확정(잠정 `/`).
- `gjc-mcp.provider.ts` — gjc MCP 설정 위치 확정 필요(미조사). 최소 안전 stub(빈 목록) 또는 조사 후.
- `gjc-models.provider.ts` — codex-models 원형. models.db 카탈로그 or 정적 fallback.

## 등록
- `server/shared/types.ts` `LLMProvider` union에 `'gjc'`.
- `src/types/app.ts` `LLMProvider`(프론트).
- `server/modules/providers/provider.registry.ts` — `GjcProvider` 등록.
- `server/modules/providers/provider.routes.ts` — provider 파싱.
- 프론트: `src/components/chat/hooks/useChatProviderState.ts`, `ProviderSelectionEmptyState.tsx`, `public/api-docs.html` PROVIDER_ORDER.
- **live 실행 경로**: `server/gjc-worker-client.ts` → mandatory `gajae-core` process host → `server/gjc-worker.ts` → GJC SDK/CLI. React·DB·browser replay는 애플리케이션이 계속 소유한다.

## 테스트
`server/modules/providers/tests/gjc-sessions.test.ts`, `server/modules/providers/tests/gjc-session-watcher.test.ts`, `server/gjc-core-host.test.ts` — 합성 JSONL fixture로 synchronizer/history를 검증하고, fake child 및 실제 Rust 프로세스로 strict framing, coalescing, multi-root add/change, 종료 수명주기를 검증한다.

## 게이트
- 실 `$HOME/.gjc` 읽기 전용. 쓰기 실험은 격리 HOME.
- 프로덕션 인스턴스 손대지 말 것 — 별도 포트 dev.
- read-only·live worker·Rust watcher 회귀 테스트와 전체 릴리스 게이트를 통과할 것.
- 기존 4 provider 무회귀.
