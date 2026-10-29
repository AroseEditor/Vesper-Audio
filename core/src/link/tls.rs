use super::proto::sha256;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{ClientConfig, DigitallySignedStruct, DistinguishedName, Error, ServerConfig, SignatureScheme};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct Identity {
    pub cert: Vec<u8>,
    pub key: Vec<u8>,
    pub fp: [u8; 32],
}

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring::default_provider())
}

pub fn load_or_create(dir: &Path, subject: &str) -> io::Result<Identity> {
    fs::create_dir_all(dir)?;
    let cert_path = dir.join("identity.cert");
    let key_path = dir.join("identity.key");
    if let (Ok(cert), Ok(key)) = (fs::read(&cert_path), fs::read(&key_path)) {
        let fp = sha256(&cert);
        return Ok(Identity { cert, key, fp });
    }
    let generated = rcgen::generate_simple_self_signed(vec![subject.to_string()]).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
    let cert = generated.cert.der().to_vec();
    let key = generated.key_pair.serialize_der();
    fs::write(&cert_path, &cert)?;
    fs::write(&key_path, &key)?;
    let fp = sha256(&cert);
    Ok(Identity { cert, key, fp })
}

#[derive(Debug)]
struct AcceptAnyClient(Arc<CryptoProvider>);

impl ClientCertVerifier for AcceptAnyClient {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(&self, _end_entity: &CertificateDer<'_>, _intermediates: &[CertificateDer<'_>], _now: UnixTime) -> Result<ClientCertVerified, Error> {
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }
}

pub fn server_config(id: &Identity) -> Result<Arc<ServerConfig>, Error> {
    let provider = provider();
    let mut config = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])?
        .with_client_cert_verifier(Arc::new(AcceptAnyClient(provider)))
        .with_single_cert(vec![CertificateDer::from(id.cert.clone())], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(id.key.clone())))?;
    config.alpn_protocols = vec![super::proto::ALPN.to_vec()];
    Ok(Arc::new(config))
}

#[derive(Debug)]
struct PinnedServer {
    provider: Arc<CryptoProvider>,
    pin: Option<[u8; 32]>,
}

impl ServerCertVerifier for PinnedServer {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, _intermediates: &[CertificateDer<'_>], _server_name: &ServerName<'_>, _ocsp: &[u8], _now: UnixTime) -> Result<ServerCertVerified, Error> {
        match self.pin {
            Some(pin) if sha256(end_entity.as_ref()) != pin => Err(Error::General("server certificate does not match the pinned fingerprint".into())),
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

pub fn client_config(id: &Identity, pin: Option<[u8; 32]>) -> Result<Arc<ClientConfig>, Error> {
    let provider = provider();
    let mut config = ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedServer { provider, pin }))
        .with_client_auth_cert(vec![CertificateDer::from(id.cert.clone())], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(id.key.clone())))?;
    config.alpn_protocols = vec![super::proto::ALPN.to_vec()];
    Ok(Arc::new(config))
}
