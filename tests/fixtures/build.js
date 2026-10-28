// Bundles the real-editor fixtures (Lexical, ProseMirror, Quill, React) with esbuild.
const path = require('path');
const esbuild = require('esbuild');
const src = path.join(__dirname, 'src');
module.exports = async function build() {
  await esbuild.build({
    entryPoints: ['lexical.js', 'prosemirror.js', 'quill.js', 'react.jsx'].map((f) => path.join(src, f)),
    bundle: true, outdir: path.join(__dirname, 'dist'), format: 'iife', minify: false,
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error'
  });
};
if (require.main === module) module.exports().then(() => console.log('fixtures built'));
