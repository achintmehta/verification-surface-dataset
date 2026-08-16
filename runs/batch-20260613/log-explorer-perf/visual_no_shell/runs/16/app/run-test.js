import { execSync } from 'child_process';
execSync('npm install @electric-sql/pglite', { stdio: 'inherit' });
execSync('node test-perf.js', { stdio: 'inherit' });
