package main

import (
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"syscall"
	"testing"
)

func TestCertificateRejection(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"unknown authority", x509.UnknownAuthorityError{}, true},
		{"distrusted chains", x509.CertificateInvalidError{Reason: x509.NoValidChains}, true},
		{"policy-only chain failure", x509.CertificateInvalidError{Reason: x509.NoValidChains, Detail: "candidate chains with invalid policies"}, false},
		{"expired certificate", x509.CertificateInvalidError{Reason: x509.Expired}, false},
		{"hostname mismatch", x509.HostnameError{Certificate: &x509.Certificate{}, Host: "example.com"}, false},
		{"timeout", &net.DNSError{Err: "timeout", IsTimeout: true}, false},
		{"DNS failure", &net.DNSError{Err: "no such host", IsNotFound: true}, false},
		{"connection refused", syscall.ECONNREFUSED, false},
		{"matching text is insufficient", errors.New("x509: no valid chains built"), false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			wrapped := &url.Error{Op: "Get", URL: "https://example.com", Err: fmt.Errorf("TLS: %w", test.err)}
			if got := certificateRejected(wrapped); got != test.want {
				t.Fatalf("certificateRejected(%T) = %v, want %v", test.err, got, test.want)
			}
		})
	}
}
