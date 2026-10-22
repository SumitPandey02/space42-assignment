import { defineConfig } from 'allure';

export default defineConfig({
  name: 'Space42 API Automation',
  output: './allure-report',
  resultsDir: './allure-results',
  plugins: {
    awesome: {
      options: {
        reportLanguage: 'en',
      },
    },
  },
});
