package com.rjgehan.notes.vault;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * UTF-8 decoding and encoding of text files (DESIGN §4.4): a leading BOM is stripped from the text and re-added on
 * write, and invalid UTF-8 decodes leniently with U+FFFD and {@code lossy = true}.
 */
public final class TextCodec {

	private static final byte[] BOM = { (byte) 0xEF, (byte) 0xBB, (byte) 0xBF };

	private TextCodec() {
	}

	public record Decoded(String text, boolean hadBom, boolean lossy) {
	}

	public static boolean hasBom(byte[] bytes) {
		return bytes.length >= 3 && bytes[0] == BOM[0] && bytes[1] == BOM[1] && bytes[2] == BOM[2];
	}

	public static Decoded decode(byte[] bytes) {
		boolean bom = hasBom(bytes);
		int offset = bom ? 3 : 0;
		try {
			String text = StandardCharsets.UTF_8.newDecoder()
				.onMalformedInput(CodingErrorAction.REPORT)
				.onUnmappableCharacter(CodingErrorAction.REPORT)
				.decode(ByteBuffer.wrap(bytes, offset, bytes.length - offset))
				.toString();
			return new Decoded(text, bom, false);
		}
		catch (CharacterCodingException ex) {
			// The String constructor replaces malformed input with U+FFFD.
			return new Decoded(new String(bytes, offset, bytes.length - offset, StandardCharsets.UTF_8), bom, true);
		}
	}

	/** Encodes as UTF-8, prepending a BOM when {@code bom} is true. */
	public static byte[] encode(String text, boolean bom) {
		byte[] body = text.getBytes(StandardCharsets.UTF_8);
		if (!bom) {
			return body;
		}
		byte[] out = new byte[body.length + 3];
		System.arraycopy(BOM, 0, out, 0, 3);
		System.arraycopy(body, 0, out, 3, body.length);
		return out;
	}

}
