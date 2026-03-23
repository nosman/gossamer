// CJS bootstrap that dynamically imports the ESM server entry point.
// utilityProcess.fork() requires a CJS file; dynamic import() bridges to ESM.
const path = require('path');
const serverEntry = path.join(__dirname, 'dist', 'serve.js');
import(serverEntry).catch(err => {
  process.stderr.write(`[gossamer-server] Fatal: ${err}\n`);
  process.exit(1);
});
