import { defineConfig } from 'vite';
import { contentSecurityPolicy } from './src/security-policy.ts';

export default defineConfig(({ command }) => {
  const development = command === 'serve';
  const policy = contentSecurityPolicy({ development });
  const responsePolicy = contentSecurityPolicy({ development, responseHeader: true });
  return {
    base: './',
    plugins: [
      {
        name: 'plass-content-security-policy',
        transformIndexHtml: {
          order: 'pre',
          handler: () => [
            {
              tag: 'meta',
              attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
              injectTo: 'head-prepend',
            },
          ],
        },
      },
    ],
    // Response CSP makes browser tests exercise the external worker's own
    // policy too. The meta policy remains necessary on static GitHub Pages.
    server: {
      port: 5199,
      strictPort: true,
      headers: { 'Content-Security-Policy': responsePolicy },
    },
    preview: { headers: { 'Content-Security-Policy': contentSecurityPolicy({ responseHeader: true }) } },
  };
});
