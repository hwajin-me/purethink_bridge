import fs from 'node:fs';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

export function loadCustomTls(env = process.env) {
  const { TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile, TLS_ROOT_CA_FILE: rootFile } = env;
  if (!certFile && !keyFile && !rootFile) return null;
  if (!certFile || !keyFile) throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be provided together');
  const cert = fs.readFileSync(certFile);
  const key = fs.readFileSync(keyFile);
  const chain = String(cert).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!chain?.length) throw new Error('TLS_CERT_FILE must contain a PEM certificate chain');
  const certificates = chain.map((pem) => new X509Certificate(pem));
  for (const certificate of certificates) {
    if (Date.now() < Date.parse(certificate.validFrom) || Date.now() > Date.parse(certificate.validTo)) {
      throw new Error('TLS certificate is expired or not yet valid');
    }
  }
  if (!certificates[0].checkHost('dapt.iptime.org', { subject: 'never' })) {
    throw new Error('TLS server certificate must include dapt.iptime.org in subjectAltName');
  }
  const options = { cert, key, minVersion: 'TLSv1.2' };
  tls.createSecureContext(options); // Reject malformed or mismatched keys before starting listeners.
  let rootCa = null;
  if (rootFile) {
    const root = new X509Certificate(fs.readFileSync(rootFile));
    if (!root.ca || !root.verify(root.publicKey) || root.subject !== root.issuer) {
      throw new Error('TLS_ROOT_CA_FILE must contain a self-signed Root CA certificate');
    }
    if (Date.now() < Date.parse(root.validFrom) || Date.now() > Date.parse(root.validTo)) {
      throw new Error('Root CA is expired or not yet valid');
    }
    const fullChain = [...certificates, root];
    for (let i = 0; i < fullChain.length - 1; i++) {
      if (!fullChain[i + 1].ca || !fullChain[i].checkIssued(fullChain[i + 1]) || !fullChain[i].verify(fullChain[i + 1].publicKey)) {
        throw new Error('TLS certificate chain does not lead to TLS_ROOT_CA_FILE');
      }
    }
    // Serialize only the public certificate, even if the supplied PEM contains other objects.
    rootCa = root.toString();
  }
  return { options, rootCa, info: { subject: certificates[0].subject,
    validTo: certificates[0].validTo, fingerprint256: certificates[0].fingerprint256,
    rootCaAvailable: Boolean(rootCa) } };
}

export function tlsListeners(env, reserved) {
  if (env.CUSTOM_BRIDGE_ENABLED && !['true', 'false'].includes(env.CUSTOM_BRIDGE_ENABLED)) throw new Error('CUSTOM_BRIDGE_ENABLED must be true or false');
  const mode = env.CUSTOM_BRIDGE_ENABLED === 'true' ? 'terminate' : 'passthrough';
  const httpPort = mode === 'terminate' ? Number(env.CUSTOM_HTTP_PORT || 80) : null;
  const httpsPort = mode === 'terminate' ? Number(env.HTTPS_PORT || 443) : null;
  const dashboardPort = env.DASHBOARD_HTTPS_PORT ? Number(env.DASHBOARD_HTTPS_PORT) : null;
  const ports = [...reserved];
  for (const port of [httpPort, httpsPort, dashboardPort].filter((v) => v !== null)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.includes(port)) throw new Error(`Invalid or conflicting TLS port: ${port}`);
    ports.push(port);
  }
  return { mode, httpPort, httpsPort, dashboardPort };
}
