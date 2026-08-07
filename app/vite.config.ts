import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    // Expose only VITE_* vars to client code via import.meta.env
    envPrefix: 'VITE_',
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('react') || id.includes('scheduler')) return 'react-vendor';
            if (id.includes('framer-motion') || id.includes('/motion/')) return 'motion-vendor';
            if (id.includes('@radix-ui')) return 'radix-vendor';
            return 'vendor';
          },
        },
      },
    },
    server: {
      // 内网穿透访问开发服务器时，仅允许明确配置的 Host。
      allowedHosts: (env.VITE_ALLOWED_HOSTS || 'frp-ski.com')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean),
      watch: {
        ignored: ['**/data/**', '**/uploads/**', '**/dist/**', '**/test-results/**', '**/.system_generated/**', '**/*.db*'],
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: env.DISABLE_HMR !== 'true' && {
        // Avoid hard-coded port collision when another Vite instance is already running.
        port: Number(env.VITE_HMR_PORT || 24679),
        clientPort: Number(env.VITE_HMR_PORT || 24679),
      },
    },
  };
});
