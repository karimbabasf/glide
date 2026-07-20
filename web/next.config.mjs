/** @type {import('next').NextConfig} */
const nextConfig = {
  headers: async () => [
    {
      // The signaling endpoint is called by the local agent (a non-browser client),
      // so it needs to be reachable cross-origin.
      source: '/api/:path*',
      headers: [
        { key: 'Access-Control-Allow-Origin', value: '*' },
        { key: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
        { key: 'Access-Control-Allow-Headers', value: 'Content-Type' },
      ],
    },
  ],
}

export default nextConfig
