import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const clientDir = path.join(rootDir, 'client');
const charactersDir = path.join(rootDir, 'characters');
const publicDir = path.join(rootDir, 'public');
const serverUrl = process.env.TIME_BOMB_SERVER_URL || 'https://timebomb-6qrl.onrender.com';

async function buildStaticSite() {
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });
  await cp(clientDir, publicDir, { recursive: true });
  await cp(charactersDir, path.join(publicDir, 'characters'), { recursive: true });
  await writeFile(
    path.join(publicDir, 'config.js'),
    `window.TIME_BOMB_SERVER_URL =\n  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'\n    ? window.location.origin\n    : ${JSON.stringify(serverUrl)};\n`,
    'utf8'
  );
  console.log('Copied client/ to public/ for Vercel deployment');
}

buildStaticSite().catch((error) => {
  console.error('Static build failed:', error);
  process.exitCode = 1;
});
