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
    fill: "border-[#0a5547] bg-[#0e7663] text-white",
    stripe: "shadow-[inset_4px_0_0_#0e7663]",
    dot: "bg-[#0e7663]",
  },
  {
    fill: "border-[#11506d] bg-[#1a6f96] text-white",
    stripe: "shadow-[inset_4px_0_0_#1a6f96]",
    dot: "bg-[#1a6f96]",
  },
  {
    fill: "border-[#334f11] bg-[#46731a] text-white",
    stripe: "shadow-[inset_4px_0_0_#46731a]",
    dot: "bg-[#46731a]",
  },
  {
    fill: "border-[#3a4480] bg-[#4f5ca8] text-white",
    stripe: "shadow-[inset_4px_0_0_#4f5ca8]",
    dot: "bg-[#4f5ca8]",
  },
  {
    fill: "border-[#6e3252] bg-[#94466f] text-white",
    stripe: "shadow-[inset_4px_0_0_#94466f]",
    dot: "bg-[#94466f]",
  },
  {
    fill: "border-[#654210] bg-[#8a5a14] text-white",
    stripe: "shadow-[inset_4px_0_0_#8a5a14]",
    dot: "bg-[#8a5a14]",
  },
  {
    fill: "border-[#7a2a38] bg-[#a33a4c] text-white",
    stripe: "shadow-[inset_4px_0_0_#a33a4c]",
    dot: "bg-[#a33a4c]",
  },
  {
    fill: "border-[#204a30] bg-[#2f6b45] text-white",
    stripe: "shadow-[inset_4px_0_0_#2f6b45]",
    dot: "bg-[#2f6b45]",
  },
  {
    fill: "border-[#2d4a52] bg-[#3f6670] text-white",
    stripe: "shadow-[inset_4px_0_0_#3f6670]",
    dot: "bg-[#3f6670]",
  },
  {
    fill: "border-[#723616] bg-[#9a4a1f] text-white",
    stripe: "shadow-[inset_4px_0_0_#9a4a1f]",
    dot: "bg-[#9a4a1f]",
  },
];

const ORDER = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"];

export function studentColor(studentId: string | undefined): StudentColor | undefined {
  if (!studentId) return undefined;
  const i = ORDER.indexOf(studentId);
  return PALETTE[(i >= 0 ? i : [...studentId].reduce((n, c) => n + c.charCodeAt(0), 0)) % PALETTE.length];
}
