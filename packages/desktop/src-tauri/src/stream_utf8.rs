//! Lossy UTF-8 decoding for one byte stream delivered in arbitrary reads.
//!
//! Decoding each read independently replaces a scalar split across a read
//! boundary with U+FFFD. This decoder holds at most the three leading bytes of
//! such a scalar until the next read, and otherwise matches
//! `String::from_utf8_lossy` over the whole stream. Keep one per stream.

/// A stream's undecoded tail: a valid prefix of a multibyte scalar.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: [u8; 3],
    pending_len: usize,
}

impl Utf8Stream {
    /// Decodes one read. Returns `None` when there is no text to emit yet.
    pub(crate) fn decode(&mut self, bytes: &[u8]) -> Option<String> {
        let mut out = String::new();
        let rest = if self.pending_len == 0 {
            bytes
        } else {
            // Room for the resolved scalar or replacement plus the rest.
            out.reserve(bytes.len() + 3);
            let consumed = self.complete_pending(bytes, &mut out);
            &bytes[consumed..]
        };
        let mut chunks = rest.utf8_chunks().peekable();
        if let Some(chunk) = chunks.peek() {
            if out.is_empty() && chunk.invalid().is_empty() {
                // The common case: the whole read is valid text.
                return Some(chunk.valid().to_owned());
            }
        }
        out.reserve(rest.len());
        while let Some(chunk) = chunks.next() {
            out.push_str(chunk.valid());
            let invalid = chunk.invalid();
            if invalid.is_empty() {
                continue;
            }
            if chunks.peek().is_none() && is_truncated(invalid) {
                self.hold(invalid);
            } else {
                out.push(char::REPLACEMENT_CHARACTER);
            }
        }
        (!out.is_empty()).then_some(out)
    }

    /// Ends the stream: a scalar still waiting for its continuation is lossy.
    pub(crate) fn finish(&mut self) -> Option<String> {
        let truncated = self.pending_len != 0;
        self.pending_len = 0;
        truncated.then(|| char::REPLACEMENT_CHARACTER.to_string())
    }

    /// Resolves the pending scalar with the start of `bytes`, returning how
    /// many of those bytes it consumed.
    fn complete_pending(&mut self, bytes: &[u8], out: &mut String) -> usize {
        let held = self.pending_len;
        let taken = bytes.len().min(4 - held);
        let mut joined = [0u8; 4];
        joined[..held].copy_from_slice(&self.pending[..held]);
        joined[held..held + taken].copy_from_slice(&bytes[..taken]);
        let joined = &joined[..held + taken];
        self.pending_len = 0;
        let Some(first) = joined.utf8_chunks().next() else {
            return 0;
        };
        if let Some(scalar) = first.valid().chars().next() {
            out.push(scalar);
            return scalar.len_utf8() - held;
        }
        let invalid = first.invalid();
        if invalid.len() == joined.len() && is_truncated(invalid) {
            // Still incomplete: this read was shorter than the scalar.
            self.hold(invalid);
            return taken;
        }
        // The held bytes cannot start a scalar here; resume after them.
        out.push(char::REPLACEMENT_CHARACTER);
        invalid.len().saturating_sub(held)
    }

    fn hold(&mut self, bytes: &[u8]) {
        self.pending[..bytes.len()].copy_from_slice(bytes);
        self.pending_len = bytes.len();
    }
}

/// Whether `bytes` (at most three) are a valid scalar prefix cut off by the
/// end of input, rather than an invalid sequence.
fn is_truncated(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes).is_err_and(|error| error.error_len().is_none())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_reads(reads: &[&[u8]]) -> (Vec<String>, String) {
        let mut stream = Utf8Stream::default();
        let mut events: Vec<String> = reads.iter().filter_map(|r| stream.decode(r)).collect();
        events.extend(stream.finish());
        let text = events.concat();
        (events, text)
    }

    /// Every way of splitting `input` into reads must decode like the whole.
    fn assert_split_invariant(input: &[u8]) {
        let expected = String::from_utf8_lossy(input);
        for first in 0..=input.len() {
            for second in first..=input.len() {
                let reads = [&input[..first], &input[first..second], &input[second..]];
                let (events, text) = decode_reads(&reads);
                assert_eq!(text, expected, "{input:?} split at {first} and {second}");
                assert!(events.iter().all(|event| !event.is_empty()));
            }
        }
        let bytes: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(decode_reads(&bytes).1, expected, "{input:?} byte by byte");
    }

    #[test]
    fn stream_utf8_split_reads_match_whole_stream_lossy_decoding() {
        for input in [
            "plain ascii\r\n\x1b[31mred\x1b[0m".as_bytes(),
            "é € 𝄞 🔒".as_bytes(),
            // Lone continuation, invalid lead and overlong encodings.
            b"a\x80b\xffc\xc0\xafd",
            // Surrogate, and a lead whose second byte is out of range.
            b"\xed\xa0\x80x\xe0\x80\x80y\xf4\x90\x80\x80",
            // A scalar interrupted by ASCII, by another lead, and at EOF.
            b"\xe2\x82A\xf0\x9f\xe2\x82\xac\xf0\x9f\x94",
        ] {
            assert_split_invariant(input);
        }
    }

    #[test]
    fn stream_utf8_holds_only_an_incomplete_scalar_until_it_resolves() {
        let mut stream = Utf8Stream::default();
        assert_eq!(stream.decode(b"ok:\xf0").as_deref(), Some("ok:"));
        assert_eq!(stream.decode(b"\x9f"), None);
        assert_eq!(stream.decode(b"\x94"), None);
        assert_eq!(stream.decode(b"\x92!").as_deref(), Some("🔒!"));
        assert_eq!(stream.finish(), None);
        // An invalid byte is reported in its own read, not held.
        assert_eq!(stream.decode(b"\xff").as_deref(), Some("\u{FFFD}"));
        assert_eq!(stream.decode(b"\xe2\x82").as_deref(), None);
        assert_eq!(stream.finish().as_deref(), Some("\u{FFFD}"));
        assert_eq!(stream.finish(), None);
    }
}
