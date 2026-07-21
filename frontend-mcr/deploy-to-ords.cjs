#!/usr/bin/env node
/**
 * Deploy built Angular MCR Manager assets to ORDS static files table.
 *
 * Uses SQLcl to upload files as base64-encoded BLOBs in chunks.
 * Run: node deploy-to-ords.cjs
 *
 * Prerequisites: npm run build (creates dist/mcr-manager/browser/)
 *
 * Workspace: MCR_MANAGER
 * App ID: 103
 * Alias: MCR
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, 'dist', 'mcr-manager', 'browser');
const SQLCL = 'e:\\oracle\\sqlcl\\bin\\sql.exe';
const CONN = 'jit_schema'; // saved connection name
const TABLE_NAME = 'mcr_static_files';
const APP_ID = 103;
const APP_ALIAS = 'MCR';
const WORKSPACE = 'MCR_MANAGER';

// Recursively get all files in dist directory
function getFiles(dir, base = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...getFiles(path.join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
  };
  return mimes[ext] || 'application/octet-stream';
}

function generateSql(files) {
  let sql = `SET SERVEROUTPUT ON\nSET DEFINE OFF\n\n`;
  sql += `-- MCR Manager Deployment\n`;
  sql += `-- Workspace: ${WORKSPACE} | App ID: ${APP_ID} | Alias: ${APP_ALIAS}\n\n`;
  sql += `DELETE FROM ${TABLE_NAME};\nCOMMIT;\n\n`;

  for (const file of files) {
    const fullPath = path.join(DIST_DIR, file);
    const bytes = fs.readFileSync(fullPath);
    const b64 = bytes.toString('base64');
    const mime = getMime(file);
    const filePath = file.replace(/\\/g, '/');

    // Split base64 into 30000-char chunks (fits in VARCHAR2(32767))
    const CHUNK_SIZE = 30000;
    const chunks = [];
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
      chunks.push(b64.substring(i, i + CHUNK_SIZE));
    }

    sql += `-- Upload: ${filePath} (${bytes.length} bytes, ${chunks.length} chunks)\n`;
    sql += `DECLARE\n`;
    sql += `    l_blob BLOB;\n`;
    sql += `    l_raw RAW(32767);\n`;
    sql += `BEGIN\n`;
    sql += `    DBMS_LOB.CREATETEMPORARY(l_blob, TRUE);\n`;

    for (let i = 0; i < chunks.length; i++) {
      sql += `    l_raw := UTL_ENCODE.BASE64_DECODE(UTL_RAW.CAST_TO_RAW('${chunks[i]}'));\n`;
      sql += `    DBMS_LOB.WRITEAPPEND(l_blob, UTL_RAW.LENGTH(l_raw), l_raw);\n`;
    }

    sql += `    INSERT INTO ${TABLE_NAME} (file_path, content_type, file_content)\n`;
    sql += `    VALUES ('${filePath}', '${mime}', l_blob);\n`;
    sql += `    DBMS_LOB.FREETEMPORARY(l_blob);\n`;
    sql += `    COMMIT;\n`;
    sql += `    DBMS_OUTPUT.PUT_LINE('Uploaded: ${filePath}');\n`;
    sql += `END;\n/\n\n`;
  }

  sql += `SELECT file_path, content_type, DBMS_LOB.GETLENGTH(file_content) as size_bytes FROM ${TABLE_NAME} ORDER BY file_path;\n`;
  sql += `EXIT;\n`;
  return sql;
}

// Main
if (!fs.existsSync(DIST_DIR)) {
  console.error(`ERROR: dist directory not found: ${DIST_DIR}`);
  console.error('Run "npm run build" first to generate the production build.');
  process.exit(1);
}

const files = getFiles(DIST_DIR);
console.log(`MCR Manager Deployment (Workspace: ${WORKSPACE}, App: ${APP_ID}, Alias: ${APP_ALIAS})`);
console.log(`Found ${files.length} files in ${DIST_DIR}:`);
files.forEach(f => console.log(`  ${f}`));

const sqlFile = path.join(__dirname, 'dist', 'deploy.sql');
const sql = generateSql(files);
fs.writeFileSync(sqlFile, sql);
console.log(`\nGenerated: ${sqlFile} (${(sql.length / 1024).toFixed(1)} KB)`);
console.log(`\nTo deploy, run:`);
console.log(`  ${SQLCL} -name ${CONN} @${sqlFile}`);
