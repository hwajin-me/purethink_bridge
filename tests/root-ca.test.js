import test from 'node:test';
import assert from 'node:assert/strict';
import selfsigned from 'selfsigned';
import forge from 'node-forge';
import { validateRootCa } from '../src/root-ca.js';
const ca = selfsigned.generate([{ name: 'commonName', value: 'Root Test' }], {
  days: 1, keySize: 2048, extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true }]
});
test('Root CA validates self-signature, constraints, dates and expected identity', () => {
  const { info } = validateRootCa(ca.cert);
  assert.equal(info.keyCertSign, true);
  assert.equal(info.fingerprintMatched, null);
  assert.equal(validateRootCa(ca.cert, info.fingerprint256).info.fingerprintMatched, true);
  assert.throws(() => validateRootCa(ca.cert, '00'.repeat(32)), /does not match/);
  assert.throws(() => validateRootCa(ca.cert, 'bad'), /64 hexadecimal/);
  assert.throws(() => validateRootCa(ca.cert + ca.private), /public PEM/);
  assert.throws(() => validateRootCa(ca.cert + ca.cert), /public PEM/);
  function altered(change) {
    const cert = forge.pki.certificateFromPem(ca.cert);
    change(cert);
    cert.sign(forge.pki.privateKeyFromPem(ca.private), forge.md.sha256.create());
    return forge.pki.certificateToPem(cert);
  }
  assert.throws(() => validateRootCa(altered(c => c.setExtensions([{ name: 'basicConstraints', cA: false }]))), /CA:TRUE/);
  assert.throws(() => validateRootCa(altered(c => c.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', digitalSignature: true }]))), /keyCertSign/);
  assert.throws(() => validateRootCa(altered(c => { c.validity.notAfter = new Date('2020-01-01'); })), /expired/);
  assert.throws(() => validateRootCa(altered(c => { c.validity.notBefore = new Date('2099-01-01'); })), /not yet valid/);
  assert.throws(() => validateRootCa(altered(c => c.setIssuer([{ name: 'commonName', value: 'Other CA' }]))), /self-signed/);
  const cert = forge.pki.certificateFromPem(ca.cert);
  cert.signature = String.fromCharCode(cert.signature.charCodeAt(0) ^ 1) + cert.signature.slice(1); // Corrupt the signature.
  assert.throws(() => validateRootCa(forge.pki.certificateToPem(cert)), /self-signed/);
});
