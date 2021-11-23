const opts = {
  // launch headless on CI, in browser locally
  headless: !!process.env.CI || !!process.env.PLAYWRIGHT_HEADLESS,
  collectCoverage: false, // not possible in Next.js 12
  executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH,
};

console.log("⚙️ Playwright options:", JSON.stringify(opts, null, 4));

module.exports = {
  verbose: true,
  preset: "jest-playwright-preset",
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  testMatch: ["<rootDir>/playwright/**/*(*.)@(spec|test).[jt]s?(x)"],
  testEnvironmentOptions: {
    "jest-playwright": {
      browsers: ["chromium" /*, 'firefox', 'webkit'*/],
      exitOnPageError: false,
      launchType: "LAUNCH",
      launchOptions: {
        headless: opts.headless,
        executablePath: opts.executablePath,
      },
      contextOptions: {
        recordVideo: {
          dir: "playwright/videos",
        },
      },
      collectCoverage: opts.collectCoverage,
    },
  },
};
