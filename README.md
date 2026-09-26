# Diro Earthquake Bot

기상청 지진 통보와 행정안전부 재난문자를 Discord 채널에 전달하는 Render 웹 서비스입니다.

## Render 설정

- Runtime: Node.js 20 이상
- Root Directory: 비워 두기 (저장소 루트)
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

기존 Root Directory가 `quake-bot`이어도 호환 진입점이 루트의 최신 코드를 실행합니다.
환경변수는 Render의 Environment에서 설정하며 저장소에 토큰이나 API 키를 넣지 마세요.

| 변수 | 용도 |
| --- | --- |
| `DISCORD_TOKEN` | 필수: Discord 봇 토큰 |
| `CHANNEL_ID` | 필수: 알림을 보낼 채널 ID (`CHANNEL_IDS` 첫 항목도 지원) |
| `KMA_KEY` | 공공데이터포털 기상청 지진정보 조회서비스 인증키 |
| `SAFETY_KEY` | 재난안전데이터공유플랫폼 긴급재난문자 인증키 |
| `LOGS` | 선택: 로그 채널 ID (`LOG_CHANNEL_ID`도 지원) |
| `PORT` | Render가 지정하는 포트 |

API 키 하나가 없으면 해당 소스만 비활성화하며 `/health`에 이유를 표시합니다.
Discord 봇에는 대상 채널의 보기, 메시지 보내기, 링크 임베드 권한이 필요합니다.
기존 알림의 `@everyone` 멘션도 유지되며 실제 멘션에는 서버 권한이 필요합니다.

## 동작 및 확인

- 1분마다 어제부터 오늘(KST)까지의 통보를 조회합니다.
- 지진은 최근 30분 내 발표된 통보를 처리해 발생 시각보다 늦게 올라온 통보도 잡습니다.
- 재난문자는 최초 실행 시 최근 5분만 전송합니다. 이후 최근 30분의 미전송 문자를 처리합니다.
- Discord가 전송을 성공한 뒤에만 중복 방지 목록에 기록합니다. 실패하면 다음 조회에 재시도합니다.
- `/health`의 `kma`, `safety`, `discord`에서 조회와 전송 오류를 확인할 수 있습니다.
- `status: ok`는 웹 서버가 응답함을 뜻합니다. 각 소스 상태도 확인하세요.
- 중복 방지 목록은 메모리에 저장되므로 재시작 시 최근 알림이 재전송될 수 있습니다.
- 이 코드는 Discord REST로 메시지를 보내며 Gateway에 접속하지 않습니다. Discord에서 봇이 오프라인으로 보여도 전송 여부는 `/health`와 채널 메시지로 확인하세요.
- Render 인스턴스가 중단되거나 휴면 상태면 조회도 중단됩니다. 저장소 수정만으로 Render 서비스 상태나 요금제를 바꾸지는 않습니다.

검증: `npm test` (외부 API와 실제 Discord 전송 없이 회귀 테스트 실행).

API 명세: [기상청](https://apihub.kma.go.kr/apiList.do?seqApi=7), [긴급재난문자](https://www.safetydata.go.kr/disaster-data/view?dataSn=228).
