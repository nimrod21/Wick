/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {},
  async rewrites() {
    return [
      { source: '/api/:path*', destination: 'http://127.0.0.1:3001/api/:path*' },
      { source: '/stream',     destination: 'http://127.0.0.1:3001/stream' },
    ];
  },
};
export default nextConfig;
