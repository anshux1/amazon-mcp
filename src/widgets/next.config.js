/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@nitrostack/widgets', '@nitrostack/core'],

  // Static export for production builds.
  ...(process.env.NODE_ENV === 'production' && {
    output: 'export',
    distDir: 'out',
    images: {
      unoptimized: true,
    },
  }),

  // Avoid stale client chunks during local widget development.
  ...(process.env.NODE_ENV === 'development' && {
    webpack: (config, { isServer }) => {
      if (config.cache?.type === 'filesystem') {
        config.cache = { type: 'memory' };
      }
      if (!isServer) {
        config.cache = false;
      }
      return config;
    },
    devIndicators: {
      buildActivity: false,
      buildActivityPosition: 'bottom-right',
    },
    compress: false,
  }),
};

export default nextConfig;
