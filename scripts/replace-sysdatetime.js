const fs = require('fs');
const path = require('path');

const targetDirs = ['lib', 'routes', 'scripts', 'sql'];
const replaceFrom = /SYSDATETIME\(\)/g;
const replaceTo = 'DATEADD(hour, 8, GETUTCDATE())';
const excludeFiles = ['replace-sysdatetime.js', 'update-db-timezone.js'];

let count = 0;

function processDirectory(dirPath) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (excludeFiles.includes(file)) continue;
    
    if (fs.statSync(fullPath).isDirectory()) {
      processDirectory(fullPath);
    } else if (fullPath.endsWith('.js') || fullPath.endsWith('.sql')) {
      // sql files might be utf-16
      let content = fs.readFileSync(fullPath, 'utf8');
      
      // if it looks like utf-16 (null bytes), read as utf16le
      if (content.includes('\u0000') && fullPath.endsWith('.sql')) {
        content = fs.readFileSync(fullPath, 'utf16le');
        if (content.match(replaceFrom)) {
          const newContent = content.replace(replaceFrom, replaceTo);
          fs.writeFileSync(fullPath, newContent, 'utf16le');
          count++;
          console.log(`Updated (UTF-16): ${fullPath}`);
        }
      } else {
        if (content.match(replaceFrom)) {
          const newContent = content.replace(replaceFrom, replaceTo);
          fs.writeFileSync(fullPath, newContent, 'utf8');
          count++;
          console.log(`Updated (UTF-8): ${fullPath}`);
        }
      }
    }
  }
}

for (const dir of targetDirs) {
  const dirPath = path.join(__dirname, '..', dir);
  if (fs.existsSync(dirPath)) {
    processDirectory(dirPath);
  }
}

console.log(`Done! Replaced SYSDATETIME() in ${count} files.`);
