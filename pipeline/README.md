# 대시보드 데이터 자동 갱신 (pipeline)

이 폴더의 스크립트는 `data/*.json` 스냅샷을 만드는 수집기입니다.
GitHub Actions 워크플로(`.github/workflows/refresh-data.yml`)가 클라우드에서
주기적으로 실행해 데이터를 갱신하고 커밋합니다 → Cloudflare Pages 자동 재배포.

## 갱신 구조 한눈에

| 데이터 | 배포본 실시간 경로 | 스냅샷(이 파이프라인) |
|---|---|---|
| 시장지표·환율 | `/api/market` (서버리스, 요청 시 라이브) | `data/market.json` (폴백) |
| 관심종목 시세 | `/api/quote` (라이브) | `data/quotes.json` (폴백) |
| 실시간 뉴스 | `/api/news` (라이브) | `data/news.json` (폴백) |
| 추천 영상 | `/api/videos` (라이브) | `data/videos.json` (폴백) |
| 경제지표·근시일 실적 | `/api/calendar` (라이브) | `data/calendar.json` |
| **한국 실적·원거리 실적 일정** | (서버리스 생성 불가) | **`data/calendar.json` ← 이 파이프라인이 핵심** |

즉, 시세·뉴스 등은 서버리스 함수가 이미 라이브로 제공하고,
이 워크플로는 **한국/원거리 실적 일정**(yfinance·nasdaq) 등 정적 스냅샷을 최신으로 유지합니다.

## 사용 방법

1. `sunnywinvest-web` 전체(이 `pipeline/`, `.github/`, `data/`, `*.html`, `functions/`, `_routes.json` 포함)를
   Cloudflare Pages에 연결된 GitHub 저장소에 푸시합니다.
2. 저장소 → **Actions** 탭에서 *대시보드 데이터 자동 갱신* 워크플로가 보이면 활성화된 것입니다.
3. **Run workflow**(workflow_dispatch)로 즉시 한 번 돌려 정상 동작을 확인하세요.
4. 이후 6시간마다 자동 실행됩니다(주기는 yml의 `cron` 으로 조정).

## 주의

- **저장소 구조**: 위 워크플로는 `sunnywinvest-web` 내용이 **저장소 루트**에 있다고 가정합니다
  (`pipeline/`, `data/`, `index.html` 등이 루트). 하위 폴더로 둔 경우 yml의 경로를 맞춰주세요.
- **외부 IP 차단 가능성**: nasdaq.com·야후(yfinance)가 드물게 GitHub Actions IP를 막을 수 있습니다.
  그럴 땐 해당 수집만 스킵되고(나머지는 정상), 가장 확실한 방법은 로컬에서
  `python fetch_calendar.py` 등을 돌려 푸시하는 것입니다.
- **빌드 횟수**: cron 주기마다 커밋·배포(Cloudflare Pages 빌드). 빌드분이 빠듯하면 주기를 늘리세요.
- 로컬 대시보드(`alpha-desk/대시보드-실행.bat` → `serve.py`)는 이와 별개로 1~5분마다 자동 갱신합니다.
