/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', "system-ui", "-apple-system", "BlinkMacSystemFont"],
      },
      colors: {
        dt: {
          primary: "rgb(var(--dt-primary-rgb) / <alpha-value>)",
          secondary: "rgb(var(--dt-secondary-rgb) / <alpha-value>)",
          forest: "rgb(var(--dt-forest-rgb) / <alpha-value>)",
          deadwood: "rgb(var(--dt-deadwood-rgb) / <alpha-value>)",
          surface: {
            base: "rgb(var(--dt-surface-base-rgb) / <alpha-value>)",
            soft: "rgb(var(--dt-surface-soft-rgb) / <alpha-value>)",
          },
          text: {
            primary: "rgb(var(--dt-text-primary-rgb) / <alpha-value>)",
          },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false, // <== disable this!
  },
};
