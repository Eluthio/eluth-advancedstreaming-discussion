import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import cssInjectedByJs from 'vite-plugin-css-injected-by-js'

export default defineConfig({
    plugins: [vue(), cssInjectedByJs()],
    build: {
        lib: {
            entry:    'src/index.js',
            name:     'EluthDiscussion',
            fileName: () => 'index.js',
            formats:  ['iife'],
        },
        rollupOptions: {
            external: ['vue'],
            output: { globals: { vue: 'Vue' } },
        },
    },
})
