const fs = require('fs');
const path = require('path');
const pgliteDir = path.dirname(require.resolve('@electric-sql/pglite'));
console.log(fs.readdirSync(path.join(pgliteDir, '..')));
