/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#172033",
        brand: {
          50: "#eef8ff",
          100: "#d9efff",
          500: "#1683d8",
          600: "#086dbb",
          700: "#075795",
        },
      },
      boxShadow: {
        panel: "0 18px 45px -24px rgba(22, 45, 75, 0.28)",
      },
    },
  },
  plugins: [],
};
