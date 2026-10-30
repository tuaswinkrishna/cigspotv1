import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    const apiOrigin = process.env.CIGSPOT_API_ORIGIN ?? "http://127.0.0.1:4000";
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      { source: "/tiles/:path*", destination: `${apiOrigin}/tiles/:path*` },
    ];
  },
};

export default nextConfig;
