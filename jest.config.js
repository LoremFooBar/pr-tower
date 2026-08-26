/** @type {import('jest').Config} */
export default {
  testEnvironment: "jsdom",
  roots: ["<rootDir>/tests"],
  transform: {
    "^.+\\.tsx?$": ["@swc/jest", { jsc: { parser: { syntax: "typescript", tsx: true } } }]
  },
  moduleFileExtensions: ["ts", "tsx", "js"]
};
