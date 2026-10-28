import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR needs HTTPS off localhost (e.g. opening the dev server from a Quest on the LAN):
//   npm run dev:https
export default defineConfig( ( { mode } ) => ( {
	// GitHub Pages serves the site under /naisui-3d/.
	base: process.env.GITHUB_PAGES ? '/naisui-3d/' : '/',
	plugins: mode === 'https' ? [ basicSsl() ] : [],
	server: { host: mode === 'https' },
} ) );
