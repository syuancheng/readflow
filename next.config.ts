import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 本地单机应用，页面数据每次都要最新，不需要组件级缓存
  cacheComponents: false,
  // 原生模块与 Node 专用依赖不能被打包，交给 Node 运行时直接 require
  serverExternalPackages: ["better-sqlite3", "jsdom", "@mozilla/readability"],
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
