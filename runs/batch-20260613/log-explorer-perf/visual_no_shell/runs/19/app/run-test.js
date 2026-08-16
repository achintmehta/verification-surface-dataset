import { execSync } from 'child_process';
console.log(execSync('node backend/test-perf.js').toString());