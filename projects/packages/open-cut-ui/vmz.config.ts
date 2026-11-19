import { defineConfig } from '@vmz/vmz';

/**
 * Review workbench: a static VMZ build that the native WebView host maps to
 * `https://app.local/`. There is no Node server at runtime; every project
 * read and preview render goes through JSON IPC.
 */
export default defineConfig({
    delivery: {
        default: 'static',
        profiles: {
            static: {
                host: 'browser',
                assembly: 'web-static',
            },
        },
    },
});
