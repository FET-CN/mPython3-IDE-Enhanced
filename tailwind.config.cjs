/** tailwind.config.cjs — scans the panel source for utility classes and emits a
 *  precompiled stylesheet that gets inlined into the panel's Shadow DOM <style>.
 *  Always-dark application UI; dark palette values are used directly as base.
 *  Shadow DOM fully isolates styles, so no extra scoping/important is needed. */
module.exports = {
  content: ["./src/ui/**/*.{mjs,js}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['system-ui', '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"],
        mono: ['ui-monospace', "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  corePlugins: {
    // Preflight resets html/body and could fight the host page; Shadow DOM already
    // isolates us. We add a minimal scoped reset in tailwind.css instead.
    preflight: false,
  },
  plugins: [],
};
