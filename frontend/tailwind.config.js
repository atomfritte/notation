/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.admin.html",
    "./index.share.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        lime: {
          accent: '#BFF355',
        }
      }
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
