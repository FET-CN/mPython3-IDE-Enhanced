/** tailwind.config.cjs — scans the panel source for utility classes and emits a
 *  precompiled stylesheet that gets inlined into the panel's Shadow DOM <style>.
 *  Light + dark via a `.dark` class (darkMode: 'class'): the panel follows the
 *  HOST SITE's theme (Vuex `state.nightSwitch`), not the OS — main.mjs toggles
 *  `dark` on the panel's `.m3e` root, and `dark:` variants layer on top. Shadow
 *  DOM fully isolates styles, so no extra scoping/important is needed. */
module.exports = {
  content: ["./src/ui/**/*.{mjs,js}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ['system-ui', '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"],
        mono: ['"M3E Mono"', "monospace"],
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
