import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, "../..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // static HTML export — deployable to Vercel, GitHub Pages, any static host
  output: "export",
  images: { unoptimized: true },
  // allow importing the library source + shared scenarios from outside this app
  experimental: { externalDir: true },
  // this is a demo app that imports the (separately CI-checked) library source
  // across the repo boundary; keep the static export resilient to that.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "htn-ai": path.resolve(repoRoot, "src/index.ts"),
      "@scenarios": path.resolve(repoRoot, "scenarios"),
    };
    return config;
  },
};

export default nextConfig;
