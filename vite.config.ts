import path from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.resolve(import.meta.dirname, 'src/web');
const backend = process.env.BACKEND_URL ?? 'http://localhost:3000';

/** Em desenvolvimento: rotas SPA do painel, /player e o service worker */
function devRoutes(): Plugin {
  return {
    name: 'gazin-dev-routes',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '/').split('?')[0]!;
        if (url === '/') {
          res.writeHead(302, { Location: '/admin' }).end();
          return;
        }
        if (url === '/player') {
          res.writeHead(302, { Location: '/player/' }).end();
          return;
        }
        if (url === '/player/sw.js') {
          const result = await server.transformRequest('/../player/sw.ts');
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Service-Worker-Allowed', '/player/');
          res.end(result?.code ?? '');
          return;
        }
        if (url === '/admin' || (url.startsWith('/admin/') && !path.extname(url))) req.url = '/index.html';
        next();
      });
    },
  };
}

export default defineConfig({
  root,
  base: '/',
  publicDir: path.resolve(import.meta.dirname, 'public'),
  plugins: [react(), tailwindcss(), devRoutes()],
  resolve: { alias: { '@': root } },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, 'src')] },
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/socket.io': { target: backend, ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        admin: path.join(root, 'index.html'),
        player: path.join(root, 'player/index.html'),
        sw: path.resolve(import.meta.dirname, 'src/player/sw.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'player/sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
