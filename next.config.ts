import type { NextConfig } from "next";

// GitHub Pages(프로젝트 페이지)는 /<repo> 하위 경로로 서빙되므로 배포 시 NEXT_PUBLIC_BASE_PATH=/v_calendar 로 빌드한다.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // 서버 없이 정적 호스팅(GitHub Pages 등)에 올릴 수 있도록 정적 export
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
