/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#07070A',
          900: '#0D0D11',
          800: '#15151B',
          700: '#1E1E26',
          600: '#2A2A34',
          500: '#3A3A46',
        },
        mist: {
          100: '#F4F4F6',
          300: '#B9B9C3',
          500: '#7C7C88',
        },
        accent: {
          DEFAULT: '#E0313B',
          hover: '#F04650',
          soft: 'rgba(224, 49, 59, 0.14)',
        },
        gold: '#D9B56C',
        online: '#3DDC84',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        cinema: '0 0 0 1px rgba(255,255,255,0.04), 0 40px 100px -30px rgba(0,0,0,0.9)',
      },
    },
  },
  plugins: [],
};
