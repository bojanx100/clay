# Kiro CLI 통합 — 요약

> AWS **Kiro CLI**를 YOKE 어댑터 계층을 통해 Claude Code, Codex와 나란히
> Clay의 1급 에이전트 런타임으로 추가합니다.

## 목표

`kiro-cli`를 Clay 안에서 Claude Code나 Codex와 똑같이 사용할 수 있게 만듭니다:
벤더 선택, 세션 생성, 대화, 도구 승인, 모델 전환 — 런타임 간 차이를 사용자가
느끼지 못하도록.

## 동작 방식

Kiro CLI는 `kiro-cli acp`를 통해 **Agent Client Protocol(ACP)**을 노출합니다 —
stdin/stdout 기반의 표준 JSON-RPC 2.0로, Zed 등이 사용하는 에디터 독립적
에이전트 프로토콜입니다. Clay가 이미 `codex app-server`에 쓰는 트랜스포트
전략과 동일합니다.

```
Clay 세션 (vendor=kiro)
    -> YOKE Kiro 어댑터    (lib/yoke/adapters/kiro.js)
    -> KiroAcpServer       (lib/yoke/kiro-acp-server.js)  `kiro-cli acp` 실행
    -> kiro-cli 바이너리   (stdio 기반 JSON-RPC 2.0)
```

### 프로토콜 생명주기 (kiro-cli 2.7.0로 검증)

| 단계 | 메서드 | 비고 |
|------|--------|------|
| 핸드셰이크 | `initialize` | `agentCapabilities` 협상 |
| 생성 | `session/new` | `{ sessionId, modes, models }` 반환 |
| 재개 | `session/load` | 히스토리 재생 |
| 모델 | `session/set_model` | `{ sessionId, modelId }` |
| 프롬프트 | `session/prompt` | 필드명은 **`prompt`**(블록 배열); `{ stopReason }`으로 resolve |
| 스트리밍 | `session/update` | `update.sessionUpdate`로 구분 |
| 승인 | `session/request_permission` | 서버→클라이언트 요청; `{ outcome: { outcome: "selected", optionId } }`로 응답 |
| 중단 | `session/cancel` | 알림(notification); 진행 중 프롬프트는 `"cancelled"`로 resolve |

## 추가한 파일

| 파일 | 목적 |
|------|------|
| `lib/yoke/kiro-acp-server.js` | 자식 프로세스 JSON-RPC 트랜스포트 (바이너리 탐색, send/notify/respond, 인증 오류 감지) |
| `lib/yoke/adapters/kiro.js` | YOKE 어댑터: 동적 모델 목록, 세션 생명주기, `session/update` 이벤트 변환, 권한 라우팅, 재개, 중단 |
| `lib/kiro-defaults.js` | Kiro 기본값(agent/mode) 단일 소스 |
| `lib/public/kiro-avatar.svg` | 브랜드 아바타 |
| `docs/guides/KIRO-INTEGRATION.md` | 전체 프로토콜 참조 + 주의사항 |

## 수정한 파일 (연결 작업 — 모든 `codex` 접점 미러링)

- `lib/yoke/index.js` — 팩토리 분기, 인증(`kiro-cli whoami`), 설치 감지, `createAdapters`
- `lib/sdk-bridge.js` — `detectInstalledVendors`, 로그인 명령, `KIRO` adapterOptions, 중립적 중단 메시지
- `lib/sdk-message-processor.js`, `lib/project-notifications.js` — 인증 타이틀 / 로그인 명령
- `lib/project-sessions.js` — kiro는 GUI 전용 세션 모드 (TUI 어댑터 없음)
- 클라이언트 UI: `index.html`(벤더 토글), `sidebar-sessions.js` / `sidebar-mobile.js`(새 세션 버튼, 설치 시에만 노출), `app-panels.js`(벤더 버튼 + effort 레벨), `app-rendering.js` / `app-messages.js` / `input.js` / `tools.js` / `mate-sidebar.js` / `sidebar-mates.js`(아바타·이름 맵)

## 핵심 설계 결정

- **동적 모델 목록** (Claude와 동일, Codex의 하드코딩 목록과 다름):
  `init()`이 `kiro-cli chat --list-models --format json`을 실행하고
  `[Internal]` / `[Deprecated]` 항목을 필터링합니다. 기본값은 `auto` 라우터 모델.
- **권한 이름 복원**: `session/request_permission` 페이로드에는
  `{ toolCallId, title }`만 담기므로, 어댑터가 직전 `tool_call` 알림의
  `kind` + `rawInput`을 캐시해 정식 도구 이름(`Bash`, `Edit` 등)을
  `canUseTool`에 전달합니다. 이게 없으면 Clay의 권한 화이트리스트 매칭이 깨집니다.
- **GUI 전용**: kiro 세션은 Codex와 마찬가지로 항상 GUI 모드로 동작합니다.
- **프로젝트별 어댑터**: ACP 프로세스는 프로젝트 cwd/slug 단위로 스코프됩니다.

## 실제 바이너리로 검증 완료

- init 시 15개 큐레이션 모델 노출; 기본값 `auto`
- 텍스트 실시간 스트리밍; `result` 이벤트에 사용량 포함
- 모델 선택 동작 (`session/set_model`)
- Bash 도구가 정식 이름 `Bash` + `{command}`로 승인 UI 표시; 승인/거부가 `canUseTool`로 라우팅
- 중단(abort)이 턴을 깔끔하게 정리
- 데몬 어댑터 경로에서 claude/codex와 나란히 등록

## 알려진 미비점

- 프로브에서 Bash `tool_result` 내용이 비어 있었습니다(출력이 이후
  `tool_call_update` 형태로 오는 것으로 추정); Codex도 유사하게 동작 — 실제
  UI에서 확인 권장.
- 최초 실행 동의 마법사가 TTY를 요구하여, 브라우저 세션 대신 어댑터/데몬 경로
  하네스로 검증했습니다. WebSocket UI 경로는 연결됐지만 브라우저에서는 미검증.
