import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react-swc'

const workspaceRoot = path.resolve(__dirname, '../..')
const coreSrc = path.join(workspaceRoot, 'packages/core/src')

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      }
    }),
  ],
  resolve: {
    alias: {
      'mir-core': coreSrc,
    },
  },
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  optimizeDeps: {
    exclude: ['mir-core'],
  },
})
