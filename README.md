# SillyTavern LLM-TRANSLATOR

*LLM을 이용해 실리태번에서 바로 번역을 하는 확장*

*기존의 빌트 인 Chat translation 확장을 참고하였음*

## 기능

- **공급자**: OpenAI, Claude, Google MakerSuite, Cohere
- **별도의 API**: 메인 API와는 별도의 API로 번역 요청
- **기존 SECRET KEY 활용**
- **파라미터 조정**: 공급자 별로 파라미터 조정 가능
- **입출력 별도의 프롬프트**: 입력 번역과 채팅 번역에 다른 번역 요청 프롬프트 사용 가능
- **원문/번역문 토글**: 재요청을 방지해 비용 절감
- **번역문 수정 가능**: 수정 후 바로 display_text에 반영

## 사용법

1. 실리태번의 extensions - install extensions에 들어가 https://github.com/1234anon/llm-translator 입력
2. 공급자와 서브 모델, 파라미터 지정, 프롬프트 입력
3. 사용하려는 공급자의 KEY 저장 여부를 API CONNECTIONS에서 확인. 없다면 API CONNECTIONS에서 키 입력.
4. 전체 채팅 번역과 입력 번역은 샌드폼 하단의 확장 메뉴를 클릭. 개별 채팅 번역은 메세지 액션 메뉴의 뇌, 원문/번역 토글은 돋보기, 번역 수정은 가위 클릭. 

## 주의 사항

- 전체 번역 시에는 메세지 수만큼 번역을 요청함. 따라서 많은 비용이 들 뿐만 아니라 짧은 시간 연속된 요청으로 쿼터 제한에 걸릴 수 있음 (쓰로틀링 기능 추가 예정)
- 각 모델의 최대 출력 길이와는 상관 없이 4000토큰까지 출력 요청을 제한함

## 스크린샷

![ui 이런 느낌](https://files.catbox.moe/5qaqgj.png)