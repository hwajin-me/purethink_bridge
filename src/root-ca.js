import { X509Certificate } from 'node:crypto';
import forge from 'node-forge';

// Node's keyUsage exposes extended key usage, not the keyCertSign bit.
function extensions(raw) {
  const certificate = forge.asn1.fromDer(raw.toString('binary'));
  const block = certificate.value[0].value.find((item) => item.tagClass === 128 && item.type === 3);
  return new Map((block?.value[0].value || []).map((item) => [
    forge.asn1.derToOid(item.value[0].value), forge.asn1.fromDer(item.value.at(-1).value)
  ]));
}

export function validateRootCa(pem, expectedFingerprint = '') {
  if (typeof pem !== 'string' || Buffer.byteLength(pem) > 16384) throw Error('Root CA PEM must be at most 16 KiB');
  if (!/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) throw Error('Provide exactly one public PEM certificate, without private keys');
  const root = new X509Certificate(pem);
  const ext = extensions(root.raw);
  const constraints = ext.get('2.5.29.19');
  if (constraints?.value[0]?.type !== 1 || constraints.value[0].value.charCodeAt(0) === 0) throw Error('Certificate must have Basic Constraints CA:TRUE');
  if (root.subject !== root.issuer || !root.verify(root.publicKey)) throw Error('Certificate must be a self-signed Root CA');
  const usage = ext.get('2.5.29.15');
  if (usage && !(usage.value.charCodeAt(1) & 0x04)) throw Error('Root CA Key Usage must allow keyCertSign');
  if (Date.now() < Date.parse(root.validFrom) || Date.now() > Date.parse(root.validTo)) throw Error('Root CA is expired or not yet valid');
  if (typeof expectedFingerprint !== 'string') throw Error('Expected SHA-256 fingerprint must be a string');
  const expected = expectedFingerprint.replace(/:/g, '').trim().toUpperCase();
  if (expected && !/^[A-F0-9]{64}$/.test(expected)) throw Error('Expected SHA-256 fingerprint must contain 64 hexadecimal digits');
  if (expected && expected !== root.fingerprint256.replace(/:/g, '')) throw Error('Root CA SHA-256 fingerprint does not match the expected CA');
  return { root, info: { subject: root.subject, issuer: root.issuer, fingerprint256: root.fingerprint256,
    validFrom: root.validFrom, validTo: root.validTo, ca: true, selfSigned: true,
    keyCertSign: usage ? true : null, fingerprintMatched: expected ? true : null,
    trust: expected ? 'matched-user-fingerprint' : 'identity-not-confirmed' } };
}
