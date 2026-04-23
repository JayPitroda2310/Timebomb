import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const clientDir = path.join(rootDir, 'client');
const publicDir = path.join(rootDir, 'public');

async function buildStaticSite() {
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });
  await cp(clientDir, publicDir, { recursive: true });
  console.log('Copied client/ to public/ for Vercel deployment');
}

buildStaticSite().catch((error) => {
  console.error('Static build failed:', error);
  process.exitCode = 1;
});
