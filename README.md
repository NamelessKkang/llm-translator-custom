# SillyTavern LLM-TRANSLATOR

LLM을 이용해 실리태번에서 바로 번역을 하는 확장

*기존의 빌트 인 Chat translation 확장을 참고하였음*

## 기능

- **공급자**: OpenAI, Claude, Google MakerSuite, Cohere
- **별도의 API**: 메인 API와는 별도의 API로 번역 요청
- **기존 SECRET KEY 활용**
- **파라미터 조정**: 공급자 별로 파라미터 조정 가능
- **입출력 별도의 프롬프트**: 입력 번역과 채팅 번역에 다른 번역 요청 프롬프트 사용 가능
- **원문/번역문 토글**: 재요청을 방지해 비용 절감
- **번역문 수정**: 수정 후 바로 display_text에 반영
- **스로틀링**: 전체 번역 시 요청 간 딜레이 설정 가능
- **전체 번역 진행 중 중단 가능**
- **프리필**: 토글 체크, 프리필 메세지 설정 후 사용
- **역방향 프록시**: 토글 체크, 리버스 프록시 링크와 패스워드 입력

## 사용법

1. 실리태번의 extensions - install extensions에 들어가 https://github.com/1234anon/llm-translator 입력
2. 공급자와 서브 모델, 파라미터 지정, 프롬프트 입력
3. 사용하려는 공급자의 KEY 저장 여부를 API CONNECTIONS에서 확인. 없다면 API CONNECTIONS에서 키 입력.
4. 전체 채팅 번역과 입력 번역은 샌드폼 하단의 확장 메뉴를 클릭. 개별 채팅 번역은 메세지 액션 메뉴의 뇌, 원문/번역 토글은 돋보기, 번역 수정은 가위 클릭. 확장 드로어에서 퀵 입력 번역 버튼 추가를 체크하면 오른쪽 샌드폼에 빠른 입력 번역 버튼이 추가됨.

## 주의 사항

- 최대 출력 길이를 반드시 지정해야하는 클로드 외의 다른 공급자는 Max Response Length를 0으로 설정하면 응답 길이에 대한 제한이 없는 상태(undefined)로 요청이 전송됨
- **업데이트 일자 기준 실리태번 최신 공식 릴리즈에서 테스트되었음. 최신 버전이 아닐 경우, 일부 기능이 정상적으로 작동하지 않을 수 있음.**

## 스크린샷

![ui 이런 느낌](https://files.catbox.moe/5qaqgj.png)

## License

Copyright (C) 2024-2025 1234anon  
Copyright (C) 2023 SillyTavern  
Based on [SillyTavern](https://github.com/SillyTavern/SillyTavern)  
Licensed under AGPL-3.0  
See LICENSE file for details.