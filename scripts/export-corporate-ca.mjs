#!/usr/bin/env node
/**
 * Export the machine's non-public root CAs to a PEM bundle for Node.
 *
 * Why this exists: this client's machines sit behind a Zscaler TLS-inspecting
 * proxy. The proxy re-signs every HTTPS response with a corporate root CA that
 * Windows trusts and Node does not, so `curl` works and Playwright fails with
 * `unable to get local issuer certificate`.
 *
 * The wrong fix is `ignoreHTTPSErrors: true` or NODE_TLS_REJECT_UNAUTHORIZED=0.
 * Both switch certificate verification off for the whole suite, which means the
 * tests can no longer tell a proxy apart from an attacker, and a genuine
 * certificate regression on the app under test would pass silently. This script
 * does the opposite: it tells Node about the extra CA and leaves verification on.
 *
 *   node scripts/export-corporate-ca.mjs
 *   # then, as the script prints:
 *   $env:NODE_EXTRA_CA_CERTS = "<repo>/certs/corporate-ca.pem"
 *
 * CI runners are not behind the proxy and need none of this.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(repoRoot, 'certs', 'corporate-ca.pem');

if (process.platform !== 'win32') {
  console.error(
    'This exporter reads the Windows certificate store. On macOS or Linux, export the\n' +
      'corporate root with `security find-certificate` or from /usr/local/share/ca-certificates\n' +
      'and point NODE_EXTRA_CA_CERTS at it.',
  );
  process.exit(1);
}

// Everything in the Root store that is not a well-known public CA is, by
// definition, locally added — a corporate root, a dev proxy, or similar. Those
// are exactly the ones Node's bundled list is missing.
const script = `
$ErrorActionPreference = 'Stop'
$certs = Get-ChildItem -Path Cert:\\LocalMachine\\Root, Cert:\\CurrentUser\\Root |
  Where-Object { $_.Subject -notmatch 'DigiCert|GlobalSign|Baltimore|VeriSign|Sectigo|USERTrust|Entrust|Go Daddy|Amazon|ISRG|Microsoft|Starfield|Certum|QuoVadis|Thawte|GeoTrust|COMODO|AAA Certificate|SecureTrust|Symantec' } |
  Sort-Object Thumbprint -Unique
foreach ($c in $certs) {
  $b64 = [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks')
  Write-Output "# $($c.Subject)"
  Write-Output "-----BEGIN CERTIFICATE-----"
  Write-Output $b64
  Write-Output "-----END CERTIFICATE-----"
}
`;

const pem = execFileSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);

const count = (pem.match(/BEGIN CERTIFICATE/g) ?? []).length;
if (count === 0) {
  console.error('No locally-added root CAs found. If TLS still fails, you are not behind a proxy.');
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, pem.replace(/\r\n/g, '\n'), 'utf8');

console.log(`Wrote ${count} certificate(s) to ${outFile}`);
console.log('\nSet it for this shell:');
console.log(`  PowerShell:  $env:NODE_EXTRA_CA_CERTS = "${outFile.replace(/\\/g, '\\\\')}"`);
console.log(`  bash:        export NODE_EXTRA_CA_CERTS="${outFile.replace(/\\/g, '/')}"`);
console.log('\nOr put it in .env as NODE_EXTRA_CA_CERTS=... and it will be picked up by the config.');
