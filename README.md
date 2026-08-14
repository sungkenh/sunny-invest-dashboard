# sunny invest dashboard

Cloudflare Pages 로 배포되는 투자 대시보드입니다. 페이지는 정적 HTML(각 파일이 자기완결),
데이터는 `functions/api/*.js` 서버리스 함수가 요청 시 라이브로 가져옵니다.
정적 스냅샷(`data/*.json`)은 함수가 실패했을 때의 폴백이며 `pipeline/` 이 주기적으로 갱신합니다.

| 페이지 | 파일 |
|---|---|
| 대시보드 | `index.html` |
| 매매 시그널 | `signals.html` |
| 분할 플래너 | `plan.html` |
| 히트맵 · 금리차 · 일정 · 영상 | `heatmap.html` · `yieldgap.html` · `schedule.html` · `videos.html` |

`capex.html`(AI투자처 찾기)·`news.html`(실시간 뉴스)은 현재 숨김 상태입니다. 파일은 보존돼 있고,
`/api/news` 는 `_routes.json` 의 `exclude` 로 정지시켜 두었습니다.

## Cloudflare Pages 설정

빌드 없이 저장소 루트를 그대로 배포합니다. 아래 설정은 대시보드에서 한 번만 해 두면 됩니다.
**바인딩·환경변수는 저장 후 재배포해야 적용됩니다.**

### 기기 간 동기화 (선택 — 켜면 PC·휴대폰이 같은 관심종목을 봅니다)

연결하지 않으면 관심종목·메모가 브라우저 localStorage 에만 저장돼 기기마다 목록이 달라집니다.
이때 `/api/store` 는 `503 kv-unbound` 를 반환하고, 대시보드 상단 칩이 «💾 이 기기에만 저장» 으로 표시됩니다.

1. Cloudflare 대시보드 → **Storage & Databases → KV** → 네임스페이스 생성 (이름은 자유)
2. Pages 프로젝트 → **Settings → Bindings**(Functions) → **KV namespace binding** 추가
3. **Variable name 을 정확히 `KV`** 로 입력하고 1번 네임스페이스를 선택 — 코드가 `env.KV` 를 찾습니다
4. 저장 후 재배포 → 칩이 «☁️ 동기화 켜짐» 으로 바뀝니다

네임스페이스에 값을 미리 넣을 필요는 없습니다. 앱이 `alphadesk:watchlist` · `alphadesk:memo`
키를 스스로 만들고, 첫 접속 기기의 목록을 올린 뒤 다른 기기의 목록과 **합집합**으로 병합합니다.
Production 과 Preview 는 바인딩이 분리돼 있으니 평소 쓰는 환경(보통 Production)에 연결하세요.

### 환경변수

| 이름 | 필요 여부 | 용도 |
|---|---|---|
| `STORE_TOKEN` | 선택 | 설정하면 `/api/store` 읽기·쓰기에 `X-Store-Token` 헤더를 요구합니다. 공개 URL 이라 개인 메모를 쓴다면 권장 — 기기마다 동기화 칩을 눌러 같은 값을 입력합니다. 설정하지 않으면 인증 검사를 건너뜁니다. |
| `TOSS_CLIENT_ID` · `TOSS_CLIENT_SECRET` | 불필요 | 토스 Open API 는 사용 중지 상태(`functions/api/toss.js` 의 `DISABLED`)라 읽지 않습니다. 남아 있다면 삭제해도 됩니다. |

## 데이터 소스 메모

- **국내 시세**: 네이버 폴링 API(지연 0). 야후 `.KS` 는 개장 직후에도 전일 종가·전일 등락을 주기 때문에
  쓰지 않습니다. 정규장 밖에는 NXT 시간외(프리 08:00~08:50 · 애프터 15:40~20:00)를 반영합니다.
- **미국 시세**: 야후 5분봉 `includePrePost` — 프리·애프터마켓 체결가 포함.
- 야후·유튜브는 Cloudflare 엣지에서 간헐적으로 차단됩니다. 네이버·nasdaq 은 안정적입니다.
  외부 소스를 의심할 때는 추측하지 말고 `.github/workflows/diag.yml`(수동 실행)로 운영에서 실측하세요.

## 검증

`pipeline/README.md` 에 데이터 파이프라인 설명이 있습니다.
페이지 로직은 스크래치패드의 유닛·E2E 테스트로 검증합니다(저장소에는 포함하지 않습니다).
`signals.html` 의 판정·백테스트 블록(`/*IND-*/` · `/*BT-*/`)과 관심종목 동기화 블록(`/*WLSYNC-*/`)은
여러 페이지에 **바이트 동일**하게 복제돼 있으며, 한쪽만 고치면 테스트가 실패합니다.
