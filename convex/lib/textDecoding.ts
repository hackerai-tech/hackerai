/**
 * Decodes the bytes of an uploaded text file.
 *
 * Windows tools commonly write UTF-16 with a byte order mark (PowerShell 5.1
 * redirection, Notepad "Unicode" saves, `.reg` exports). Decoding those bytes
 * as UTF-8 yields replacement characters and a NUL between every character, so
 * the BOM selects the decoder. Big-endian input is byte-swapped rather than
 * relying on a `utf-16be` decoder, which needs full ICU in the runtime.
 */
export const decodeTextBytes = (bytes: Uint8Array): string => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
    for (let i = 0; i < swapped.length; i += 2) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }

  // The UTF-8 decoder already drops a UTF-8 BOM.
  return new TextDecoder("utf-8").decode(bytes);
};
