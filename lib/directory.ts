/**
 * 사용자 목록(강사·레슨생) — 데모 모드는 테스트베드, 서버 모드는 서버의 회원 목록.
 * 이름 표시 함수(userName)가 어디서나 같은 목록을 쓰도록 모듈에 한 벌만 둔다.
 * 스토어가 목록을 바꿀 때 setDirectory 로 함께 갱신한다.
 */
import type { User } from "../types/calendar";

let users: User[] = [];

export function setDirectory(list: User[]) {
  users = list;
}

export const getDirectory = () => users;

export const userName = (id: string | undefined) => users.find((u) => u.id === id)?.name ?? "알 수 없음";

export const instructorOf = (list: User[] = users) => list.find((u) => u.role === "INSTRUCTOR");
