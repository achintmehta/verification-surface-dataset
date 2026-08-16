const fs = require('fs');
const path = require('path');
const pgliteDir = path.dirname(require.resolve('@electric-sql/pglite'));
const pkg = require(path.join(pgliteDir, '..', 'package.json'));
console.log(JSON.stringify(pkg.exports, null, 2));
