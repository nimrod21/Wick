/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {},
  async rewrites() {
    return [
      { source: '/api/:path*', destination: 'http://127.0.0.1:3001/api/:path*' },
    ];
  },
  async redirects() {
    // /market was absorbed by the dashboard's asset view (IMPL-6C) — an old
    // bookmark lands on the page that replaced it instead of on a 404.
    return [{ source: '/market', destination: '/', permanent: false }];
  },
};
export default nextConfig;
