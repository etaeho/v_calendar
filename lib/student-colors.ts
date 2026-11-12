/**
 * 강사 화면에서 레슨생별 확정 레슨 색. 기본 민트에서 크게 벗어나지 않게 조금씩만 다르게 하고,
 * 다른 의미가 있는 색(노랑=응답 대기, 보라 점선=변경 요청, 파랑/코랄=외부 캘린더)과는 겹치지 않게 했다.
 * Tailwind 가 클래스를 찾을 수 있도록 전체 문자열로 적는다.
 */
export interface StudentColor {
  /** 확정 레슨 배지 */
  fill: string;
  /** 응답 대기·변경 요청 등 다른 상태의 왼쪽 띠 */
  stripe: string;
  /** 사이드바 색 점 */
  dot: string;
}

const PALETTE: StudentColor[] = [
  {
    fill: "border-[#0b6b59] bg-[#129078] text-white",
    stripe: "shadow-[inset_4px_0_0_#129078]",
    dot: "bg-[#129078]",
  },
  {
    fill: "border-[#15587a] bg-[#1f7aa6] text-white",
    stripe: "shadow-[inset_4px_0_0_#1f7aa6]",
    dot: "bg-[#1f7aa6]",
  },
  {
    fill: "border-[#3e5f12] bg-[#5a8a1c] text-white",
    stripe: "shadow-[inset_4px_0_0_#5a8a1c]",
    dot: "bg-[#5a8a1c]",
  },
  {
    fill: "border-[#3f4a8a] bg-[#5664b3] text-white",
    stripe: "shadow-[inset_4px_0_0_#5664b3]",
    dot: "bg-[#5664b3]",
  },
  {
    fill: "border-[#7a3a5c] bg-[#a14f7c] text-white",
    stripe: "shadow-[inset_4px_0_0_#a14f7c]",
    dot: "bg-[#a14f7c]",
  },
];

const ORDER = ["s1", "s2", "s3", "s4", "s5"];

export function studentColor(studentId: string | undefined): StudentColor | undefined {
  if (!studentId) return undefined;
  const i = ORDER.indexOf(studentId);
  return PALETTE[(i >= 0 ? i : [...studentId].reduce((n, c) => n + c.charCodeAt(0), 0)) % PALETTE.length];
}
