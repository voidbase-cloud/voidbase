import terser from '@rollup/plugin-terser';
import ts     from 'rollup-plugin-ts';

const isProduction = !process.env.ROLLUP_WATCH;

function basePlugins() {
    return [
        ts(),

        // @todo before v1, test if feasible and consider removing the minification for the npm builds
        // (https://github.com/pocketbase/js-sdk/issues/261)
        //
        // minify if we're building for production
        // (aka. npm run build instead of npm run dev)
        isProduction && terser({
            keep_classnames: true,
            keep_fnames: true,
            output: {
                comments: false,
            },
        }),
    ]
}

// The plugin entries (@voidbase-cloud/sdk/offline, /pwa, /editable, /ai, /payments, /seo, /i18n) import only types
// from the main entry, so their bundles carry no second copy of the client;
// the package self-reference stays external for the declarations.
const pluginExternal = ["@voidbase-cloud/sdk"];

// The ES (.mjs), ES with .js extension (React Native) and CommonJS bundles
// of one plugin entry.
function pluginBundles(name) {
    return [
        {
            input: `src/${name}.ts`,
            external: pluginExternal,
            output: [
                {
                    file:      `dist/${name}.es.mjs`,
                    format:    'es',
                    sourcemap: isProduction,
                },
            ],
            plugins: basePlugins(),
            watch: { clearScreen: false },
        },
        {
            input: `src/${name}.ts`,
            external: pluginExternal,
            output: [
                {
                    file:      `dist/${name}.es.js`,
                    format:    'es',
                    sourcemap: isProduction,
                },
            ],
            plugins: basePlugins(),
            watch: { clearScreen: false },
        },
        {
            input: `src/${name}.ts`,
            external: pluginExternal,
            output: [
                {
                    file:      `dist/${name}.cjs.js`,
                    format:    'cjs',
                    sourcemap: isProduction,
                },
            ],
            plugins: basePlugins(),
            watch: { clearScreen: false },
        },
    ];
}

export default [
    ...pluginBundles('offline'),
    ...pluginBundles('pwa'),
    ...pluginBundles('editable'),
    ...pluginBundles('ai'),
    ...pluginBundles('payments'),
    ...pluginBundles('seo'),
    ...pluginBundles('i18n'),

    // ES bundle (the PocketBase client as default export + additional helper classes).
    {
        input: 'src/index.ts',
        output: [
            {
                file:      'dist/pocketbase.es.mjs',
                format:    'es',
                sourcemap: isProduction,
            },
        ],
        plugins: basePlugins(),
        watch: { clearScreen: false },
    },

    // ES bundle but with .js extension.
    //
    // This is needed mainly because of React Native not recognizing the mjs
    // extension by default (see https://github.com/pocketbase/js-sdk/issues/47).
    {
        input: 'src/index.ts',
        output: [
            {
                file:      'dist/pocketbase.es.js',
                format:    'es',
                sourcemap: isProduction,
            },
        ],
        plugins: basePlugins(),
        watch: { clearScreen: false },
    },

    // UMD bundle (only the PocketBase client as default export).
    {
        input: 'src/Client.ts',
        output: [
            {
                name:      'PocketBase',
                file:      'dist/pocketbase.umd.js',
                format:    'umd',
                exports:   'default',
                sourcemap: isProduction,
            },
        ],
        plugins: basePlugins(),
        watch: { clearScreen: false },
    },

    // CommonJS bundle (only the PocketBase client as default export).
    {
        input: 'src/Client.ts',
        output: [
            {
                name:      'PocketBase',
                file:      'dist/pocketbase.cjs.js',
                format:    'cjs',
                exports:   'default',
                sourcemap: isProduction,
            }
        ],
        plugins: basePlugins(),
        watch: { clearScreen: false },
    },

    // !!!
    // @deprecated - kept only for backwards compatibility and will be removed in v1.0.0
    // !!!
    //
    // Browser-friendly iife bundle (only the PocketBase client as default export).
    {
        input: 'src/Client.ts',
        output: [
            {
                name:      'PocketBase',
                file:      'dist/pocketbase.iife.js',
                format:    'iife',
                sourcemap: isProduction,
            },
        ],
        plugins: basePlugins(),
        watch: { clearScreen: false },
    },
];
