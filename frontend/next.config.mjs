/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next dev mode blocks cross-origin requests (including the HMR
  // WebSocket) from hosts other than localhost by default — needed here
  // since the dashboard is reached via the LAN IP for the OptiFleet demo.
  allowedDevOrigins: ["192.168.10.196"],
};

export default nextConfig;
