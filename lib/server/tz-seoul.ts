/**
 * 테스트 전용: 이 모듈을 가장 먼저 import 하면 프로세스 시간대가 Asia/Seoul 이 된다.
 * (node --test 는 파일마다 별도 프로세스라 다른 테스트에 영향이 없다. 서버는 TZ=Asia/Seoul 로 동작한다)
 */
process.env.TZ = "Asia/Seoul";
