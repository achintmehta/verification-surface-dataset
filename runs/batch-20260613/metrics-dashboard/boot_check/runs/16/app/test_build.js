import { execSync } from 'child_process';
try {
  execSync('npx vite build client', { stdio: 'inherit' });
} catch (e) {
  console.error(e);
}