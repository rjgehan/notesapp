# Third-party notices

NotesApp is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`, see [LICENSE](LICENSE)).
The NotesApp image ships the third-party software listed below, each under its own licence. Where an entry names several
licences, they are the alternatives or the combination its project declares. Each package's full licence text is in its
source distribution: `frontend/node_modules/<package>/` for the web app, `clipper/node_modules/<package>/` for the web
clipper, and the `META-INF` folder of each jar inside the server's Spring Boot jar.

This file is generated; do not edit it by hand. After a dependency change, regenerate it from the repository root with
`node scripts/third-party-notices.mjs` (it reads `frontend/package-lock.json` and `clipper/package-lock.json` and
resolves the backend's runtime dependencies with the Maven wrapper).

## Web app (bundled by Vite)

The production dependencies of `frontend/package.json`, direct and transitive. Development tools (Vite, TypeScript,
Vitest, ESLint and so on) are not shipped.

| Package | Licence | Source |
|---|---|---|
| @antfu/install-pkg | MIT | <https://github.com/antfu-collective/install-pkg> |
| @babel/generator | MIT | <https://babel.dev/docs/en/next/babel-generator> |
| @babel/helper-string-parser | MIT | <https://babel.dev/docs/en/next/babel-helper-string-parser> |
| @babel/helper-validator-identifier | MIT | <https://github.com/babel/babel> |
| @babel/parser | MIT | <https://babel.dev/docs/en/next/babel-parser> |
| @babel/runtime | MIT | <https://babel.dev/docs/en/next/babel-runtime> |
| @babel/types | MIT | <https://babel.dev/docs/en/next/babel-types> |
| @braintree/sanitize-url | MIT | <https://github.com/braintree/sanitize-url> |
| @chevrotain/cst-dts-gen | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| @chevrotain/gast | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| @chevrotain/regexp-to-ast | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| @chevrotain/types | Apache-2.0 | <https://chevrotain.io/documentation/> |
| @chevrotain/utils | Apache-2.0 | <https://github.com/Chevrotain/chevrotain> |
| @codemirror/autocomplete | MIT | <https://code.haverbeke.berlin/codemirror/autocomplete> |
| @codemirror/commands | MIT | <https://code.haverbeke.berlin/codemirror/commands> |
| @codemirror/lang-angular | MIT | <https://github.com/codemirror/lang-angular> |
| @codemirror/lang-cpp | MIT | <https://github.com/codemirror/lang-cpp> |
| @codemirror/lang-css | MIT | <https://github.com/codemirror/lang-css> |
| @codemirror/lang-go | MIT | <https://github.com/codemirror/lang-go> |
| @codemirror/lang-html | MIT | <https://code.haverbeke.berlin/codemirror/lang-html> |
| @codemirror/lang-java | MIT | <https://github.com/codemirror/lang-java> |
| @codemirror/lang-javascript | MIT | <https://github.com/codemirror/lang-javascript> |
| @codemirror/lang-jinja | MIT | <https://code.haverbeke.berlin/codemirror/lang-jinja> |
| @codemirror/lang-json | MIT | <https://github.com/codemirror/lang-json> |
| @codemirror/lang-less | MIT | <https://github.com/codemirror/lang-less> |
| @codemirror/lang-liquid | MIT | <https://code.haverbeke.berlin/codemirror/lang-liquid> |
| @codemirror/lang-markdown | MIT | <https://code.haverbeke.berlin/codemirror/lang-markdown> |
| @codemirror/lang-php | MIT | <https://github.com/codemirror/lang-php> |
| @codemirror/lang-python | MIT | <https://github.com/codemirror/lang-python> |
| @codemirror/lang-rust | MIT | <https://github.com/codemirror/lang-rust> |
| @codemirror/lang-sass | MIT | <https://github.com/codemirror/lang-sass> |
| @codemirror/lang-sql | MIT | <https://github.com/codemirror/lang-sql> |
| @codemirror/lang-vue | MIT | <https://github.com/codemirror/lang-vue> |
| @codemirror/lang-wast | MIT | <https://github.com/codemirror/lang-wast> |
| @codemirror/lang-xml | MIT | <https://github.com/codemirror/lang-xml> |
| @codemirror/lang-yaml | MIT | <https://github.com/codemirror/lang-yaml> |
| @codemirror/language | MIT | <https://code.haverbeke.berlin/codemirror/language> |
| @codemirror/language-data | MIT | <https://github.com/codemirror/language-data> |
| @codemirror/legacy-modes | MIT | <https://code.haverbeke.berlin/codemirror/legacy-modes> |
| @codemirror/lint | MIT | <https://code.haverbeke.berlin/codemirror/lint> |
| @codemirror/merge | MIT | <https://code.haverbeke.berlin/codemirror/merge> |
| @codemirror/search | MIT | <https://code.haverbeke.berlin/codemirror/search> |
| @codemirror/state | MIT | <https://code.haverbeke.berlin/codemirror/state> |
| @codemirror/streamparser | MIT | <https://code.haverbeke.berlin/codemirror/streamparser> |
| @codemirror/view | MIT | <https://code.haverbeke.berlin/codemirror/view> |
| @emotion/is-prop-valid | MIT | <https://github.com/emotion-js/emotion/tree/main/packages/is-prop-valid> |
| @emotion/memoize | MIT | <https://github.com/emotion-js/emotion/tree/main/packages/memoize> |
| @excalidraw/excalidraw | MIT | <https://github.com/excalidraw/excalidraw/tree/master/packages/excalidraw> |
| @excalidraw/laser-pointer | MIT |  |
| @excalidraw/markdown-to-text | MIT | <https://github.com/danestves/markdown-to-text> |
| @excalidraw/mermaid-to-excalidraw | MIT |  |
| @excalidraw/random-username | MIT | <https://github.com/excalidraw/random-username> |
| @floating-ui/core | MIT | <https://floating-ui.com> |
| @floating-ui/dom | MIT | <https://floating-ui.com> |
| @floating-ui/react-dom | MIT | <https://floating-ui.com/docs/react-dom> |
| @floating-ui/utils | MIT | <https://floating-ui.com> |
| @glideapps/glide-data-grid | MIT | <https://grid.glideapps.com> |
| @iconify/types | MIT | <https://github.com/iconify/iconify> |
| @iconify/utils | MIT | <https://iconify.design/docs/libraries/utils/> |
| @joplin/turndown-plugin-gfm | MIT | <https://github.com/laurent22/joplin-turndown-plugin-gfm> |
| @jridgewell/gen-mapping | MIT | <https://github.com/jridgewell/sourcemaps/tree/main/packages/gen-mapping> |
| @jridgewell/resolve-uri | MIT | <https://github.com/jridgewell/resolve-uri> |
| @jridgewell/sourcemap-codec | MIT | <https://github.com/jridgewell/sourcemaps/tree/main/packages/sourcemap-codec> |
| @jridgewell/trace-mapping | MIT | <https://github.com/jridgewell/sourcemaps/tree/main/packages/trace-mapping> |
| @lezer/common | MIT | <https://code.haverbeke.berlin/lezer/common> |
| @lezer/cpp | MIT | <https://code.haverbeke.berlin/lezer/cpp> |
| @lezer/css | MIT | <https://code.haverbeke.berlin/lezer/css> |
| @lezer/go | MIT | <https://github.com/lezer-parser/go> |
| @lezer/highlight | MIT | <https://code.haverbeke.berlin/lezer/highlight> |
| @lezer/html | MIT | <https://github.com/lezer-parser/html> |
| @lezer/java | MIT | <https://code.haverbeke.berlin/lezer/java> |
| @lezer/javascript | MIT | <https://code.haverbeke.berlin/lezer/javascript> |
| @lezer/json | MIT | <https://github.com/lezer-parser/json> |
| @lezer/lr | MIT | <https://code.haverbeke.berlin/lezer/lr> |
| @lezer/markdown | MIT | <https://code.haverbeke.berlin/lezer/markdown> |
| @lezer/php | MIT | <https://code.haverbeke.berlin/lezer/php> |
| @lezer/python | MIT | <https://code.haverbeke.berlin/lezer/python> |
| @lezer/rust | MIT | <https://code.haverbeke.berlin/lezer/rust> |
| @lezer/sass | MIT | <https://github.com/lezer-parser/sass> |
| @lezer/xml | MIT | <https://github.com/lezer-parser/xml> |
| @lezer/yaml | MIT | <https://github.com/lezer-parser/yaml> |
| @linaria/core | MIT | <https://github.com/callstack/linaria> |
| @linaria/react | MIT | <https://github.com/callstack/linaria> |
| @marijn/find-cluster-break | MIT | <https://code.haverbeke.berlin/marijn/find-cluster-break> |
| @mdit/helper | MIT | <https://mdit-plugins.github.io/> |
| @mdit/plugin-footnote | MIT | <https://mdit-plugins.github.io/footnote.html> |
| @mdit/plugin-inline-rule | MIT | <https://mdit-plugins.github.io/inline-rule.html> |
| @mdit/plugin-mark | MIT | <https://mdit-plugins.github.io/mark.html> |
| @mdit/plugin-tasklist | MIT | <https://mdit-plugins.github.io/tasklist.html> |
| @mdit/plugin-tex | MIT | <https://mdit-plugins.github.io/tex.html> |
| @mermaid-js/parser | MIT | <https://github.com/mermaid-js/mermaid/tree/develop/packages/mermaid/parser/> |
| @mixmark-io/domino | BSD-2-Clause | <https://github.com/mixmark-io/domino> |
| @napi-rs/canvas | MIT | <https://github.com/Brooooooklyn/canvas> |
| @napi-rs/canvas-android-arm64 | MIT |  |
| @napi-rs/canvas-darwin-arm64 | MIT |  |
| @napi-rs/canvas-darwin-x64 | MIT |  |
| @napi-rs/canvas-linux-arm-gnueabihf | MIT |  |
| @napi-rs/canvas-linux-arm64-gnu | MIT |  |
| @napi-rs/canvas-linux-arm64-musl | MIT |  |
| @napi-rs/canvas-linux-riscv64-gnu | MIT |  |
| @napi-rs/canvas-linux-x64-gnu | MIT |  |
| @napi-rs/canvas-linux-x64-musl | MIT |  |
| @napi-rs/canvas-win32-arm64-msvc | MIT |  |
| @napi-rs/canvas-win32-x64-msvc | MIT | <https://github.com/Brooooooklyn/canvas> |
| @radix-ui/primitive | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-arrow | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-collection | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-compose-refs | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-context | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-direction | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-dismissable-layer | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-focus-guards | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-focus-scope | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-id | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-popover | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-popper | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-portal | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-presence | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-primitive | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-roving-focus | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-slot | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-tabs | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-use-callback-ref | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-use-controllable-state | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-use-escape-keydown | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-use-layout-effect | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-use-rect | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/react-use-size | MIT | <https://radix-ui.com/primitives> |
| @radix-ui/rect | MIT | <https://radix-ui.com/primitives> |
| @remix-run/route-pattern | MIT | <https://github.com/remix-run/remix/tree/main/packages/route-pattern> |
| @replit/codemirror-vim | MIT | <https://github.com/replit/codemirror-vim> |
| @replit/codemirror-vim-core | MIT | <https://github.com/replit/codemirror-vim> |
| @tanstack/query-core | MIT | <https://tanstack.com/query> |
| @tanstack/react-query | MIT | <https://tanstack.com/query> |
| @upsetjs/venn.js | MIT | <https://github.com/upsetjs/venn.js> |
| @wyw-in-js/processor-utils | MIT |  |
| @wyw-in-js/shared | MIT |  |
| anymatch | ISC | <https://github.com/micromatch/anymatch> |
| argparse | PSF-2.0 | <https://github.com/nodeca/argparse> |
| aria-hidden | MIT | <https://github.com/theKashey/aria-hidden> |
| balanced-match | MIT | <https://github.com/juliangruber/balanced-match> |
| binary-extensions | MIT | <https://github.com/sindresorhus/binary-extensions> |
| brace-expansion | MIT | <https://github.com/juliangruber/brace-expansion> |
| braces | MIT | <https://github.com/micromatch/braces> |
| browser-fs-access | Apache-2.0 | <https://github.com/GoogleChromeLabs/browser-fs-access> |
| canvas-hypertxt | MIT | <https://github.com/glideapps/canvas-hypertxt> |
| canvas-roundrect-polyfill | MIT | <https://github.com/Kaiido/roundRect> |
| chevrotain | Apache-2.0 | <https://chevrotain.io/docs/> |
| chevrotain-allstar | MIT | <https://github.com/langium/chevrotain-allstar> |
| chokidar | MIT | <https://github.com/paulmillr/chokidar> |
| chrono-node | MIT | <http://github.com/wanasit/chrono> |
| classnames | MIT | <https://github.com/JedWatson/classnames> |
| clsx | MIT | <https://github.com/lukeed/clsx> |
| commander | MIT | <https://github.com/tj/commander.js> |
| cookie-es | MIT | <https://github.com/unjs/cookie-es> |
| cose-base | MIT | <https://github.com/iVis-at-Bilkent/cose-base> |
| crc-32 | Apache-2.0 | <https://github.com/SheetJS/js-crc32> |
| crelt | MIT | <https://code.haverbeke.berlin/marijn/crelt> |
| cross-env | MIT | <https://github.com/kentcdodds/cross-env> |
| cross-spawn | MIT | <https://github.com/moxystudio/node-cross-spawn> |
| cytoscape | MIT | <http://js.cytoscape.org> |
| cytoscape-cose-bilkent | MIT | <https://github.com/cytoscape/cytoscape.js-cose-bilkent> |
| cytoscape-fcose | MIT | <https://github.com/iVis-at-Bilkent/cytoscape.js-fcose> |
| d3 | ISC | <https://d3js.org> |
| d3-array | ISC / BSD-3-Clause | <https://d3js.org/d3-array/> |
| d3-axis | ISC | <https://d3js.org/d3-axis/> |
| d3-brush | ISC | <https://d3js.org/d3-brush/> |
| d3-chord | ISC | <https://d3js.org/d3-chord/> |
| d3-color | ISC | <https://d3js.org/d3-color/> |
| d3-contour | ISC | <https://d3js.org/d3-contour/> |
| d3-delaunay | ISC | <https://github.com/d3/d3-delaunay> |
| d3-dispatch | ISC | <https://d3js.org/d3-dispatch/> |
| d3-drag | ISC | <https://d3js.org/d3-drag/> |
| d3-dsv | ISC | <https://d3js.org/d3-dsv/> |
| d3-ease | BSD-3-Clause | <https://d3js.org/d3-ease/> |
| d3-fetch | ISC | <https://d3js.org/d3-fetch/> |
| d3-force | ISC | <https://d3js.org/d3-force/> |
| d3-format | ISC | <https://d3js.org/d3-format/> |
| d3-geo | ISC | <https://d3js.org/d3-geo/> |
| d3-hierarchy | ISC | <https://d3js.org/d3-hierarchy/> |
| d3-interpolate | ISC | <https://d3js.org/d3-interpolate/> |
| d3-path | ISC / BSD-3-Clause | <https://d3js.org/d3-path/> |
| d3-polygon | ISC | <https://d3js.org/d3-polygon/> |
| d3-quadtree | ISC | <https://d3js.org/d3-quadtree/> |
| d3-random | ISC | <https://d3js.org/d3-random/> |
| d3-sankey | BSD-3-Clause | <https://github.com/d3/d3-sankey> |
| d3-scale | ISC | <https://d3js.org/d3-scale/> |
| d3-scale-chromatic | ISC | <https://d3js.org/d3-scale-chromatic/> |
| d3-selection | ISC | <https://d3js.org/d3-selection/> |
| d3-shape | BSD-3-Clause / ISC | <https://d3js.org/d3-shape/> |
| d3-time | ISC | <https://d3js.org/d3-time/> |
| d3-time-format | ISC | <https://d3js.org/d3-time-format/> |
| d3-timer | ISC | <https://d3js.org/d3-timer/> |
| d3-transition | ISC | <https://d3js.org/d3-transition/> |
| d3-zoom | ISC | <https://d3js.org/d3-zoom/> |
| dagre-d3-es | MIT | <https://github.com/tbo47/dagre-es> |
| dayjs | MIT | <https://day.js.org> |
| debug | MIT | <https://github.com/debug-js/debug> |
| delaunator | ISC | <https://github.com/mapbox/delaunator> |
| detect-node-es | MIT | <https://github.com/thekashey/detect-node> |
| dompurify | (MPL-2.0 OR Apache-2.0) | <https://github.com/cure53/DOMPurify> |
| elkjs | EPL-2.0 | <https://github.com/kieler/elkjs> |
| entities | BSD-2-Clause | <https://github.com/fb55/entities> |
| es-errors | MIT | <https://github.com/ljharb/es-errors> |
| es-toolkit | MIT | <https://es-toolkit.dev> |
| es6-promise-pool | MIT | <https://github.com/timdp/es6-promise-pool> |
| fastdom | MIT | <https://github.com/wilsonpage/fastdom> |
| fill-range | MIT | <https://github.com/jonschlinkert/fill-range> |
| find-up | MIT | <https://github.com/sindresorhus/find-up> |
| fractional-indexing | CC0-1.0 | <https://github.com/rocicorp/fractional-indexing> |
| fsevents | MIT |  |
| function-bind | MIT | <https://github.com/Raynos/function-bind> |
| fuzzy | MIT | <https://github.com/mattyork/fuzzy> |
| fuzzysort | MIT | <https://github.com/farzher/fuzzysort> |
| get-nonce | MIT | <https://github.com/theKashey/get-nonce> |
| glob-parent | ISC | <https://github.com/gulpjs/glob-parent> |
| glur | MIT | <https://github.com/andr83/glur/issues> |
| hachure-fill | MIT | <https://github.com/pshihn/hachure-fill> |
| hasown | MIT | <https://github.com/inspect-js/hasOwn> |
| html-element-attributes | MIT | <https://github.com/wooorm/html-element-attributes> |
| hyperformula | GPL-3.0-only | <https://hyperformula.handsontable.com/> |
| iconv-lite | MIT | <https://github.com/ashtuchkin/iconv-lite> |
| image-blob-reduce | MIT | <https://github.com/nodeca/image-blob-reduce> |
| immutable | MIT | <https://immutable-js.com> |
| import-meta-resolve | MIT | <https://github.com/wooorm/import-meta-resolve> |
| inherits | ISC | <https://github.com/isaacs/inherits> |
| internmap | ISC | <https://github.com/mbostock/internmap/> |
| is-binary-path | MIT | <https://github.com/sindresorhus/is-binary-path> |
| is-core-module | MIT | <https://github.com/inspect-js/is-core-module> |
| is-extglob | MIT | <https://github.com/jonschlinkert/is-extglob> |
| is-glob | MIT | <https://github.com/micromatch/is-glob> |
| is-number | MIT | <https://github.com/jonschlinkert/is-number> |
| isexe | ISC | <https://github.com/isaacs/isexe> |
| jotai | MIT | <https://github.com/pmndrs/jotai> |
| jotai-scope | MIT | <https://github.com/jotaijs/jotai-scope> |
| js-tokens | MIT | <https://github.com/lydell/js-tokens> |
| jsesc | MIT | <https://mths.be/jsesc> |
| katex | MIT | <https://katex.org> |
| khroma | MIT | <https://github.com/fabiospampinato/khroma> |
| langium | MIT | <https://langium.org> |
| layout-base | MIT | <https://github.com/iVis-at-Bilkent/layout-base> |
| linkify-it | MIT | <https://github.com/markdown-it/linkify-it> |
| locate-path | MIT | <https://github.com/sindresorhus/locate-path> |
| lodash | MIT | <https://lodash.com/> |
| lodash-es | MIT | <https://lodash.com/custom-builds> |
| lodash.debounce | MIT | <https://lodash.com/> |
| lodash.throttle | MIT | <https://lodash.com/> |
| loose-envify | MIT | <https://github.com/zertosh/loose-envify> |
| lucide-react | ISC | <https://lucide.dev> |
| lz-string | MIT | <http://pieroxy.net/blog/pages/lz-string/index.html> |
| markdown-it | MIT | <https://github.com/markdown-it/markdown-it> |
| marked | MIT | <https://marked.js.org> |
| mdurl | MIT | <https://github.com/markdown-it/mdurl> |
| mermaid | MIT | <https://github.com/mermaid-js/mermaid> |
| minimatch | ISC | <https://github.com/isaacs/minimatch> |
| ms | MIT | <https://github.com/vercel/ms> |
| multimath | MIT | <https://github.com/nodeca/multimath> |
| nanoid | MIT | <https://github.com/ai/nanoid> |
| normalize-path | MIT | <https://github.com/jonschlinkert/normalize-path> |
| object-assign | MIT | <https://github.com/sindresorhus/object-assign> |
| open-color | MIT | <https://github.com/yeun/open-color> |
| p-limit | MIT | <https://github.com/sindresorhus/p-limit> |
| p-locate | MIT | <https://github.com/sindresorhus/p-locate> |
| package-manager-detector | MIT | <https://github.com/antfu-collective/package-manager-detector> |
| pako | (MIT AND Zlib) | <https://github.com/nodeca/pako> |
| path-data-parser | MIT | <https://github.com/pshihn/path-data-parser> |
| path-exists | MIT | <https://github.com/sindresorhus/path-exists> |
| path-key | MIT | <https://github.com/sindresorhus/path-key> |
| path-parse | MIT | <https://github.com/jbgutierrez/path-parse> |
| pdfjs-dist | Apache-2.0 | <https://mozilla.github.io/pdf.js/> |
| perfect-freehand | MIT | <https://github.com/steveruizok/perfect-freehand> |
| pica | MIT | <https://github.com/nodeca/pica> |
| picomatch | MIT | <https://github.com/micromatch/picomatch> |
| png-chunk-text | MIT | <https://github.com/hughsk/png-chunk-text> |
| png-chunks-encode | MIT | <https://github.com/hughsk/png-chunks-encode> |
| png-chunks-extract | MIT | <https://github.com/hughsk/png-chunks-extract> |
| points-on-curve | MIT | <https://github.com/pshihn/bezier-points> |
| points-on-path | MIT | <https://github.com/pshihn/points-on-path> |
| prop-types | MIT | <https://facebook.github.io/react/> |
| punycode.js | MIT | <https://mths.be/punycode> |
| pwacompat | Apache-2.0 | <https://github.com/GoogleChrome/pwacompat> |
| react | MIT | <https://react.dev/> |
| react-dom | MIT | <https://react.dev/> |
| react-easy-swipe | MIT | <http://leandrowd.github.io/react-easy-swipe/> |
| react-html-attributes | MIT | <https://github.com/jackyho112/react-html-attributes> |
| react-is | MIT | <https://reactjs.org/> |
| react-number-format | MIT | <https://s-yadav.github.io/react-number-format/docs/intro> |
| react-remove-scroll | MIT | <https://github.com/theKashey/react-remove-scroll> |
| react-remove-scroll-bar | MIT | <https://github.com/theKashey/react-remove-scroll-bar> |
| react-responsive-carousel | MIT | <http://leandrowd.github.io/react-responsive-carousel/> |
| react-router | MIT | <https://github.com/remix-run/react-router> |
| react-style-singleton | MIT | <https://github.com/theKashey/react-style-singleton> |
| readdirp | MIT | <https://github.com/paulmillr/readdirp> |
| regexp-to-ast | MIT | <https://github.com/bd82/regexp-to-ast> |
| resolve | MIT | <ssh://github.com/browserify/resolve> |
| robust-predicates | Unlicense | <https://github.com/mourner/robust-predicates> |
| roughjs | MIT | <https://roughjs.com> |
| rrule | BSD-3-Clause | <http://jakubroztocil.github.io/rrule/> |
| rw | BSD-3-Clause | <https://github.com/mbostock/rw> |
| safer-buffer | MIT | <https://github.com/ChALkeR/safer-buffer> |
| sass | MIT | <https://github.com/sass/dart-sass> |
| scheduler | MIT | <https://react.dev/> |
| shebang-command | MIT | <https://github.com/kevva/shebang-command> |
| shebang-regex | MIT | <https://github.com/sindresorhus/shebang-regex> |
| sliced | MIT | <https://github.com/aheckmann/sliced> |
| source-map-js | BSD-3-Clause | <https://github.com/7rulnik/source-map-js> |
| strictdom | MIT | <https://github.com/wilsonpage/strictdom> |
| style-mod | MIT | <https://code.haverbeke.berlin/marijn/style-mod> |
| stylis | MIT | <https://github.com/thysultan/stylis.js> |
| supports-preserve-symlinks-flag | MIT | <https://github.com/inspect-js/node-supports-preserve-symlinks-flag> |
| tiny-emitter | MIT | <https://github.com/scottcorgan/tiny-emitter> |
| tinyexec | MIT | <https://github.com/tinylibs/tinyexec> |
| to-regex-range | MIT | <https://github.com/micromatch/to-regex-range> |
| ts-dedent | MIT | <https://github.com/tamino-martinius/node-ts-dedent> |
| ts-fsrs | MIT | <https://github.com/open-spaced-repetition/ts-fsrs> |
| ts-invariant | MIT | <https://github.com/apollographql/invariant-packages> |
| tslib | 0BSD | <https://www.typescriptlang.org/> |
| tunnel-rat | MIT | <https://github.com/pmndrs/tunnel-rat> |
| turndown | MIT | <https://github.com/mixmark-io/turndown> |
| uc.micro | MIT | <https://github.com/markdown-it/uc.micro> |
| use-callback-ref | MIT | <https://github.com/theKashey/use-callback-ref/> |
| use-sidecar | MIT | <https://github.com/theKashey/use-sidecar> |
| use-sync-external-store | MIT | <https://github.com/react/react> |
| uuid | MIT | <https://github.com/uuidjs/uuid> |
| vscode-jsonrpc | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| vscode-languageserver | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| vscode-languageserver-protocol | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| vscode-languageserver-textdocument | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| vscode-languageserver-types | MIT | <https://github.com/Microsoft/vscode-languageserver-node> |
| vscode-uri | MIT | <https://github.com/microsoft/vscode-uri> |
| w3c-keyname | MIT | <https://github.com/marijnh/w3c-keyname> |
| webworkify | MIT | <https://github.com/substack/webworkify> |
| which | ISC | <https://github.com/isaacs/node-which> |
| xlsx | Apache-2.0 | <https://sheetjs.com/> |
| yaml | ISC | <https://eemeli.org/yaml/> |
| yocto-queue | MIT | <https://github.com/sindresorhus/yocto-queue> |
| zustand | MIT | <https://github.com/pmndrs/zustand> |

## Web clipper (bundled by esbuild)

The production dependencies of `clipper/package.json`: the scripts the server serves under `/clipper/` and the browser
extension built from the same sources (ROADMAP item 19). turndown's DOM for Node (`@mixmark-io/domino`) is left out of
the browser bundles.

| Package | Licence | Source |
|---|---|---|
| @mixmark-io/domino | BSD-2-Clause | <https://github.com/mixmark-io/domino> |
| @mozilla/readability | Apache-2.0 | <https://github.com/mozilla/readability> |
| turndown | MIT | <https://github.com/mixmark-io/turndown> |
| turndown-plugin-gfm | MIT | <https://github.com/domchristie/turndown-plugin-gfm> |

## Server (in the Spring Boot jar)

The compile and runtime dependencies of `backend/pom.xml`, direct and transitive. Test-only dependencies are not shipped.

| Artifact | Licence | Source |
|---|---|---|
| ch.qos.logback:logback-classic | EPL-2.0 / LGPL-2.1-only | <http://logback.qos.ch> |
| ch.qos.logback:logback-core | EPL-2.0 / LGPL-2.1-only | <http://logback.qos.ch> |
| com.anthropic:anthropic-java | Apache-2.0 | <https://docs.anthropic.com/claude/reference/> |
| com.anthropic:anthropic-java-client-okhttp | Apache-2.0 | <https://docs.anthropic.com/claude/reference/> |
| com.anthropic:anthropic-java-core | Apache-2.0 | <https://docs.anthropic.com/claude/reference/> |
| com.fasterxml:classmate | Apache-2.0 | <https://github.com/FasterXML/java-classmate> |
| com.fasterxml.jackson.core:jackson-annotations | Apache-2.0 | <https://github.com/FasterXML/jackson> |
| com.fasterxml.jackson.core:jackson-core | Apache-2.0 | <https://github.com/FasterXML/jackson-core> |
| com.fasterxml.jackson.core:jackson-databind | Apache-2.0 | <https://github.com/FasterXML/jackson> |
| com.fasterxml.jackson.datatype:jackson-datatype-jdk8 | Apache-2.0 | <https://github.com/FasterXML/jackson-modules-java8> |
| com.fasterxml.jackson.datatype:jackson-datatype-jsr310 | Apache-2.0 | <https://github.com/FasterXML/jackson-modules-java8> |
| com.fasterxml.jackson.module:jackson-module-kotlin | Apache-2.0 | <https://github.com/FasterXML/jackson-module-kotlin> |
| com.github.victools:jsonschema-generator | Apache-2.0 | <https://github.com/victools/jsonschema-generator> |
| com.github.victools:jsonschema-module-jackson | Apache-2.0 | <https://github.com/victools/jsonschema-generator> |
| com.github.victools:jsonschema-module-swagger-2 | Apache-2.0 | <https://github.com/victools/jsonschema-generator> |
| com.google.errorprone:error_prone_annotations | Apache-2.0 | <https://errorprone.info> |
| com.googlecode.javaewah:JavaEWAH | Apache-2.0 | <https://github.com/lemire/javaewah> |
| com.squareup.okhttp3:okhttp | Apache-2.0 | <https://square.github.io/okhttp/> |
| com.squareup.okio:okio | Apache-2.0 | <https://github.com/square/okio/> |
| com.squareup.okio:okio-jvm | Apache-2.0 | <https://github.com/square/okio/> |
| com.standardwebhooks:standardwebhooks | MIT | <https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/java> |
| commons-codec:commons-codec | Apache-2.0 | <https://commons.apache.org/proper/commons-codec/> |
| commons-logging:commons-logging | Apache-2.0 | <https://commons.apache.org/proper/commons-logging/> |
| io.micrometer:micrometer-commons | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| io.micrometer:micrometer-core | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| io.micrometer:micrometer-jakarta9 | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| io.micrometer:micrometer-observation | Apache-2.0 | <https://github.com/micrometer-metrics/micrometer-commercial> |
| io.opentelemetry:opentelemetry-api | Apache-2.0 | <https://github.com/open-telemetry/opentelemetry-java> |
| io.opentelemetry:opentelemetry-common | Apache-2.0 | <https://github.com/open-telemetry/opentelemetry-java> |
| io.opentelemetry:opentelemetry-context | Apache-2.0 | <https://github.com/open-telemetry/opentelemetry-java> |
| io.swagger.core.v3:swagger-annotations | Apache-2.0 | <https://github.com/swagger-api/swagger-core> |
| jakarta.annotation:jakarta.annotation-api | EPL-2.0 / GPL-2.0-with-classpath-exception | <https://projects.eclipse.org/projects/ee4j.ca> |
| jakarta.validation:jakarta.validation-api | Apache-2.0 | <https://beanvalidation.org> |
| org.apache.logging.log4j:log4j-api | Apache-2.0 | <https://logging.apache.org/log4j/2.x/> |
| org.apache.logging.log4j:log4j-to-slf4j | Apache-2.0 | <https://logging.apache.org/log4j/2.x/> |
| org.apache.pdfbox:fontbox | Apache-2.0 | <http://pdfbox.apache.org/> |
| org.apache.pdfbox:pdfbox | Apache-2.0 | <https://svn.apache.org/viewvc/pdfbox/tags/3.0.8/pdfbox> |
| org.apache.pdfbox:pdfbox-io | Apache-2.0 | <https://svn.apache.org/viewvc/pdfbox/tags/3.0.8/io> |
| org.apache.tomcat.embed:tomcat-embed-core | Apache-2.0 | <https://tomcat.apache.org/> |
| org.apache.tomcat.embed:tomcat-embed-el | Apache-2.0 | <https://tomcat.apache.org/> |
| org.apache.tomcat.embed:tomcat-embed-websocket | Apache-2.0 | <https://tomcat.apache.org/> |
| org.commonmark:commonmark | BSD-2-Clause | <https://github.com/commonmark/commonmark-java> |
| org.commonmark:commonmark-ext-autolink | BSD-2-Clause | <https://github.com/commonmark/commonmark-java> |
| org.commonmark:commonmark-ext-footnotes | BSD-2-Clause | <https://github.com/commonmark/commonmark-java> |
| org.commonmark:commonmark-ext-gfm-strikethrough | BSD-2-Clause | <https://github.com/commonmark/commonmark-java> |
| org.commonmark:commonmark-ext-gfm-tables | BSD-2-Clause | <https://github.com/commonmark/commonmark-java> |
| org.commonmark:commonmark-ext-heading-anchor | BSD-2-Clause | <https://github.com/commonmark/commonmark-java> |
| org.commonmark:commonmark-ext-task-list-items | BSD-2-Clause | <https://github.com/commonmark/commonmark-java> |
| org.dmfs:jems2 | Apache-2.0 | <https://github.com/dmfs/jems> |
| org.dmfs:lib-recur | Apache-2.0 | <https://github.com/dmfs/lib-recur> |
| org.dmfs:rfc5545-datetime | Apache-2.0 | <https://github.com/dmfs/rfc5545-datetime> |
| org.eclipse.jgit:org.eclipse.jgit | BSD-3-Clause | <https://www.eclipse.org/jgit/> |
| org.hdrhistogram:HdrHistogram | CC0-1.0 / BSD-2-Clause | <http://hdrhistogram.github.io/HdrHistogram/> |
| org.hibernate.validator:hibernate-validator | Apache-2.0 | <https://hibernate.org/validator> |
| org.jboss.logging:jboss-logging | Apache-2.0 | <https://www.jboss.org> |
| org.jetbrains:annotations | Apache-2.0 | <http://www.jetbrains.org> |
| org.jetbrains.kotlin:kotlin-reflect | Apache-2.0 | <https://kotlinlang.org/> |
| org.jetbrains.kotlin:kotlin-stdlib | Apache-2.0 | <https://kotlinlang.org/> |
| org.jetbrains.kotlin:kotlin-stdlib-common | Apache-2.0 | <https://kotlinlang.org/> |
| org.jetbrains.kotlin:kotlin-stdlib-jdk7 | Apache-2.0 | <https://kotlinlang.org/> |
| org.jetbrains.kotlin:kotlin-stdlib-jdk8 | Apache-2.0 | <https://kotlinlang.org/> |
| org.jspecify:jspecify | Apache-2.0 | <https://jspecify.dev/> |
| org.nibor.autolink:autolink | MIT | <https://github.com/robinst/autolink-java> |
| org.slf4j:jul-to-slf4j | MIT | <http://www.slf4j.org> |
| org.slf4j:slf4j-api | MIT | <http://www.slf4j.org> |
| org.snakeyaml:snakeyaml-engine | Apache-2.0 | <https://codeberg.org/snakeyaml/snakeyaml-engine> |
| org.springframework:spring-aop | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-beans | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-context | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-core | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-expression | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-web | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework:spring-webmvc | Apache-2.0 | <https://github.com/spring-projects/spring-framework> |
| org.springframework.boot:spring-boot | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-actuator | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-actuator-autoconfigure | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-autoconfigure | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-health | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-http-converter | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-jackson | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-micrometer-metrics | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-micrometer-observation | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-servlet | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-actuator | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-jackson | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-logging | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-micrometer-metrics | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-tomcat | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-tomcat-runtime | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-validation | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-starter-webmvc | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-tomcat | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-validation | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-web-server | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.springframework.boot:spring-boot-webmvc | Apache-2.0 | <https://spring.io/projects/spring-boot> |
| org.yaml:snakeyaml | Apache-2.0 | <https://bitbucket.org/snakeyaml/snakeyaml> |
| tools.jackson.core:jackson-core | Apache-2.0 | <https://github.com/FasterXML/jackson-core> |
| tools.jackson.core:jackson-databind | Apache-2.0 | <https://github.com/FasterXML/jackson> |

## Container image

The image's base layers (the Eclipse Temurin JRE on Ubuntu, see the `Dockerfile`) are third-party software under their
own licences, which the base images document.
