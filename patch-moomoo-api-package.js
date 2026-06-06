#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const packageFile = path.join(__dirname, 'node_modules', 'moomoo-api', 'package.json');

if (!fs.existsSync(packageFile)) {
  console.error('moomoo-api is not installed. Run: npm install');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
if (pkg.type !== 'module') {
  pkg.type = 'module';
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log('Patched moomoo-api package.json with type=module');
} else {
  console.log('moomoo-api package.json already has type=module');
}
