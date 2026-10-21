package com.rjgehan.notes.index;

import java.io.IOException;
import java.nio.file.Path;

import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;

/**
 * Extracts the text of a PDF with Apache PDFBox (DESIGN §5.5.10), page by page, within limits: at most
 * {@code maxPages} pages and {@code maxChars} characters, and no new page once {@code deadline} (a
 * {@link System#nanoTime()} value) has passed. Pages are joined with a line holding a form feed ({@code "\n\f\n"}),
 * so a search hit can name its page; control characters other than line breaks and tabs are dropped.
 */
public final class PdfText {

	/** The page separator in extracted text. */
	public static final String PAGE_BREAK = "\n\f\n";

	private PdfText() {
	}

	/** The text, the number of pages read, and whether a limit cut it short. */
	public record Result(String text, int pages, boolean truncated) {
	}

	/** Thrown when the document needs a password to be opened. */
	public static final class EncryptedException extends IOException {

		EncryptedException(Throwable cause) {
			super("The PDF is encrypted", cause);
		}

	}

	public static Result extract(Path file, int maxPages, int maxChars, long deadline) throws IOException {
		try (PDDocument document = Loader.loadPDF(file.toFile())) {
			PDFTextStripper stripper = new PDFTextStripper();
			stripper.setLineSeparator("\n");
			stripper.setPageStart("");
			stripper.setPageEnd("");
			stripper.setSortByPosition(false);
			int total = document.getNumberOfPages();
			int pages = Math.min(total, Math.max(0, maxPages));
			StringBuilder text = new StringBuilder();
			boolean truncated = pages < total;
			int read = 0;
			for (int page = 1; page <= pages; page++) {
				if (System.nanoTime() - deadline > 0 || text.length() >= maxChars) {
					truncated = true;
					break;
				}
				stripper.setStartPage(page);
				stripper.setEndPage(page);
				String pageText = clean(stripper.getText(document));
				if (page > 1) {
					text.append(PAGE_BREAK);
				}
				text.append(pageText);
				read++;
			}
			if (text.length() > maxChars) {
				int end = maxChars;
				if (end > 0 && Character.isHighSurrogate(text.charAt(end - 1))) {
					end--;
				}
				text.setLength(end);
				truncated = true;
			}
			return new Result(text.toString(), read, truncated);
		}
		catch (org.apache.pdfbox.pdmodel.encryption.InvalidPasswordException ex) {
			throw new EncryptedException(ex);
		}
	}

	/** Line breaks become {@code \n}; other control characters (form feeds included) are dropped; lines trimmed. */
	static String clean(String raw) {
		StringBuilder out = new StringBuilder(raw.length());
		for (int i = 0; i < raw.length(); i++) {
			char c = raw.charAt(i);
			if (c == '\r') {
				if (i + 1 < raw.length() && raw.charAt(i + 1) == '\n') {
					continue;
				}
				out.append('\n');
			}
			else if (c == '\n' || c == '\t' || (c >= 0x20 && c != 0x7F)) {
				out.append(c);
			}
		}
		int end = out.length();
		while (end > 0 && Character.isWhitespace(out.charAt(end - 1))) {
			end--;
		}
		out.setLength(end);
		return out.toString();
	}

}
